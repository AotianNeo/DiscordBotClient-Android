#!/usr/bin/env python3
"""
Builds and signs the standalone single-APK DiscordBotClient for Android
(`dist/DiscordBotClient-Android.apk`) from Discord Android v351011 (`351.11 - Stable`)
split APKs + `dist/revenge.bundle`, using native Android SDK C++ tools
(`aapt2`, `dexdump`, `zipalign`) and APK Signature Scheme v2.

Zero Root, zero Frida, zero Xposed/LSPatch, zero external runtime dependencies.
"""
import argparse
import datetime
import hashlib
import os
import shutil
import struct
import subprocess
import zipfile
import zlib
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parent.parent


def resolve_build_tool(tool_name: str) -> Path:
    explicit_dir = os.environ.get("ANDROID_BUILD_TOOLS_DIR")
    if explicit_dir:
        candidate = Path(explicit_dir) / tool_name
        if candidate.is_file():
            return candidate

    sdk_roots = [
        os.environ.get("ANDROID_SDK_ROOT"),
        os.environ.get("ANDROID_HOME"),
        "/usr/local/lib/android/sdk",
        "/opt/homebrew/share/android-commandlinetools",
        str(Path.home() / "Library/Android/sdk"),
        str(Path.home() / "Android/Sdk"),
    ]
    for sdk in sdk_roots:
        if not sdk:
            continue
        bt_root = Path(sdk) / "build-tools"
        if bt_root.is_dir():
            for ver_dir in sorted(bt_root.iterdir(), reverse=True):
                candidate = ver_dir / tool_name
                if candidate.is_file():
                    return candidate

    which_hit = shutil.which(tool_name)
    if which_hit:
        return Path(which_hit)

    raise FileNotFoundError(
        f"Could not locate Android SDK build-tool '{tool_name}'. "
        "Set ANDROID_SDK_ROOT or ANDROID_BUILD_TOOLS_DIR."
    )


def read_uleb128(buf: bytes, pos: int) -> tuple[int, int]:
    res = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        res |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            break
        shift += 7
    return res, pos


def patch_classes3_dex(orig_dex: bytes) -> bytes:
    """
    Patches `com.facebook.react.runtime.ReactInstance.loadJSBundle(JSBundleLoader)`
    in-place inside `classes3.dex` (`insns_size = 27` 16-bit code units preserved
    with zero string/type/method/offset table shifts and 100% intact `map_list`)
    so `this.loadJSBundleFromAssets(this.context.getAssets(), "assets://bundle")`
    executes right before Discord's main JSBundleLoader (`index.android.bundle`
    or OTA file bundle).
    """
    buf = bytearray(orig_dex)

    string_ids_size, string_ids_off = struct.unpack_from("<II", buf, 56)
    type_ids_size, type_ids_off = struct.unpack_from("<II", buf, 64)
    field_ids_size, field_ids_off = struct.unpack_from("<II", buf, 80)
    method_ids_size, method_ids_off = struct.unpack_from("<II", buf, 88)
    class_defs_size, class_defs_off = struct.unpack_from("<II", buf, 96)

    def get_str(idx: int) -> str:
        off = struct.unpack_from("<I", buf, string_ids_off + idx * 4)[0]
        _, p = read_uleb128(buf, off)
        end = buf.index(0, p)
        return bytes(buf[p:end]).decode("utf-8", errors="replace")

    def get_type(idx: int) -> str:
        return get_str(struct.unpack_from("<I", buf, type_ids_off + idx * 4)[0])

    # Verify all symbol indices dynamically against classes3.dex
    str_assets_prefix = None
    str_bundle_name = None
    for i in range(string_ids_size):
        s = get_str(i)
        if s == "assets://":
            str_assets_prefix = i
        elif s == "bundle":
            str_bundle_name = i
    assert str_assets_prefix is not None and str_bundle_name is not None, "Missing 'assets://' or 'bundle' string"

    type_delegate = None
    for i in range(type_ids_size):
        if get_type(i) == "Lcom/facebook/react/runtime/ReactInstance$loadJSBundle$1;":
            type_delegate = i
            break
    assert type_delegate is not None

    field_context = None
    for i in range(field_ids_size):
        fc, ft, fn = struct.unpack_from("<HHI", buf, field_ids_off + i * 8)
        if (
            get_type(fc) == "Lcom/facebook/react/runtime/ReactInstance;"
            and get_str(fn) == "context"
            and get_type(ft) == "Lcom/facebook/react/runtime/BridgelessReactContext;"
        ):
            field_context = i
            break
    assert field_context is not None

    m_concat = None
    m_get_assets = None
    m_load_assets = None
    m_delegate_init = None
    m_load_script = None
    m_target_load_js = None

    for i in range(method_ids_size):
        mc, _, mn = struct.unpack_from("<HHI", buf, method_ids_off + i * 8)
        cls_name = get_type(mc)
        meth_name = get_str(mn)
        if cls_name == "Ljava/lang/String;" and meth_name == "concat":
            m_concat = i
        elif cls_name == "Landroid/content/Context;" and meth_name == "getAssets":
            m_get_assets = i
        elif cls_name == "Lcom/facebook/react/runtime/ReactInstance;" and meth_name == "loadJSBundleFromAssets":
            m_load_assets = i
        elif cls_name == "Lcom/facebook/react/runtime/ReactInstance$loadJSBundle$1;" and meth_name == "<init>":
            m_delegate_init = i
        elif cls_name == "Lcom/facebook/react/bridge/JSBundleLoader;" and meth_name == "loadScript":
            m_load_script = i
        elif cls_name == "Lcom/facebook/react/runtime/ReactInstance;" and meth_name == "loadJSBundle":
            m_target_load_js = i

    assert all(
        x is not None
        for x in (m_concat, m_get_assets, m_load_assets, m_delegate_init, m_load_script, m_target_load_js)
    )

    # Locate code_off of ReactInstance.loadJSBundle(JSBundleLoader)V
    target_code_off = None
    for ci in range(class_defs_size):
        off = class_defs_off + ci * 32
        c_type_idx, _, _, _, _, _, class_data_off, _ = struct.unpack_from("<IIIIIIII", buf, off)
        if get_type(c_type_idx) == "Lcom/facebook/react/runtime/ReactInstance;":
            p = class_data_off
            sf_sz, p = read_uleb128(buf, p)
            if_sz, p = read_uleb128(buf, p)
            dm_sz, p = read_uleb128(buf, p)
            vm_sz, p = read_uleb128(buf, p)
            for _ in range(sf_sz + if_sz):
                _, p = read_uleb128(buf, p)
                _, p = read_uleb128(buf, p)
            m_idx = 0
            for _ in range(dm_sz):
                d, p = read_uleb128(buf, p)
                _, p = read_uleb128(buf, p)
                _, p = read_uleb128(buf, p)
                m_idx += d
            m_idx = 0
            for _ in range(vm_sz):
                d, p = read_uleb128(buf, p)
                _, p = read_uleb128(buf, p)
                c_off, p = read_uleb128(buf, p)
                m_idx += d
                if m_idx == m_target_load_js:
                    target_code_off = c_off
                    break
            break

    assert target_code_off is not None, "Could not locate ReactInstance.loadJSBundle code_off"
    regs, ins, outs, tries, dbg, insns_sz = struct.unpack_from("<HHHHII", buf, target_code_off)
    assert (regs, ins, tries, insns_sz) == (4, 2, 0, 27), f"Unexpected code_item header: {(regs, ins, outs, tries, insns_sz)}"

    def insn_35c(op: int, count: int, idx: int, reg_list: list[int]) -> bytes:
        r = reg_list + [0] * (5 - len(reg_list))
        a_g = ((count & 0xF) << 4) | (r[4] & 0xF)
        b = (op & 0xFF) | (a_g << 8)
        fedc = (r[0] & 0xF) | ((r[1] & 0xF) << 4) | ((r[2] & 0xF) << 8) | ((r[3] & 0xF) << 12)
        return struct.pack("<HHH", b, idx, fedc)

    def insn_21c(op: int, reg: int, idx: int) -> bytes:
        return struct.pack("<BBH", op, reg & 0xFF, idx)

    def insn_22c(op: int, dst: int, obj: int, idx: int) -> bytes:
        return struct.pack("<BBH", op, ((obj & 0xF) << 4) | (dst & 0xF), idx)

    def insn_11x(op: int, reg: int) -> bytes:
        return struct.pack("<BB", op, reg & 0xFF)

    def insn_10x(op: int) -> bytes:
        return struct.pack("<BB", op, 0)

    # Registers: v0, v1 = scratch; v2 = p0 (this: ReactInstance); v3 = p1 (bundleLoader: JSBundleLoader)
    patched_insns = b"".join(
        [
            insn_21c(0x1A, 0, str_assets_prefix),          # const-string v0, "assets://"
            insn_21c(0x1A, 1, str_bundle_name),            # const-string v1, "bundle"
            insn_35c(0x6E, 2, m_concat, [0, 1]),           # invoke-virtual {v0, v1}, String.concat(String)String
            insn_11x(0x0C, 1),                             # move-result-object v1 -> "assets://bundle"
            insn_22c(0x54, 0, 2, field_context),           # iget-object v0, v2, ReactInstance.context
            insn_35c(0x6E, 1, m_get_assets, [0]),          # invoke-virtual {v0}, Context.getAssets()AssetManager
            insn_11x(0x0C, 0),                             # move-result-object v0 -> AssetManager
            insn_35c(0x70, 3, m_load_assets, [2, 0, 1]),   # invoke-direct {v2, v0, v1}, ReactInstance.loadJSBundleFromAssets
            insn_21c(0x22, 0, type_delegate),              # new-instance v0, ReactInstance$loadJSBundle$1
            insn_35c(0x70, 2, m_delegate_init, [0, 2]),    # invoke-direct {v0, v2}, ReactInstance$loadJSBundle$1.<init>
            insn_35c(0x6E, 2, m_load_script, [3, 0]),      # invoke-virtual {v3, v0}, JSBundleLoader.loadScript
            insn_10x(0x0E),                                # return-void
            insn_10x(0x00),                                # nop
        ]
    )
    assert len(patched_insns) == 27 * 2, f"Expected 54 bytes, got {len(patched_insns)}"

    # Update code_item header (outs_size=3, debug_info_off=0) + instructions in-place
    struct.pack_into("<HHHHII", buf, target_code_off, 4, 2, 3, 0, 0, 27)
    buf[target_code_off + 16 : target_code_off + 16 + 54] = patched_insns

    # Recompute DEX SHA-1 signature and Adler32 checksum
    buf[12:32] = hashlib.sha1(buf[32:]).digest()
    checksum = zlib.adler32(buf[12:]) & 0xFFFFFFFF
    struct.pack_into("<I", buf, 8, checksum)
    return bytes(buf)


def parse_utf16_axml_string_pool(buf: bytes, off: int) -> list[str]:
    _, chsz, _, scnt, _, flags, sstart, _ = struct.unpack_from("<HHIIIIII", buf, off)
    is_utf8 = bool(flags & 0x100)
    offsets = [struct.unpack_from("<I", buf, off + chsz + i * 4)[0] for i in range(scnt)]
    pool_data = off + sstart
    out = []
    for rel in offsets:
        p = pool_data + rel
        if is_utf8:
            b1 = buf[p]
            p += 2 if (b1 & 0x80) else 1
            b2 = buf[p]
            p += 1
            if b2 & 0x80:
                u8len = ((b2 & 0x7F) << 8) | buf[p]
                p += 1
            else:
                u8len = b2
            out.append(buf[p : p + u8len].decode("utf-8", errors="replace"))
        else:
            u16len = struct.unpack_from("<H", buf, p)[0]
            p += 2
            if u16len & 0x8000:
                u16len = ((u16len & 0x7FFF) << 16) | struct.unpack_from("<H", buf, p)[0]
                p += 2
            out.append(buf[p : p + u16len * 2].decode("utf-16le", errors="replace"))
    return out


def build_utf16_string_pool(strings: list[str]) -> bytes:
    offsets = []
    blob = bytearray()
    for s in strings:
        offsets.append(len(blob))
        u16_bytes = s.encode("utf-16-le")
        u16_len = len(u16_bytes) // 2
        if u16_len > 0x7FFF:
            blob.extend(struct.pack("<HH", ((u16_len >> 16) & 0x7FFF) | 0x8000, u16_len & 0xFFFF))
        else:
            blob.extend(struct.pack("<H", u16_len))
        blob.extend(u16_bytes)
        blob.extend(b"\x00\x00")

    while len(blob) % 4 != 0:
        blob.append(0)

    header_sz = 28
    strings_start = header_sz + 4 * len(strings)
    chunk_sz = strings_start + len(blob)
    out = bytearray(struct.pack("<HHIIIIII", 0x0001, header_sz, chunk_sz, len(strings), 0, 0, strings_start, 0))
    for off in offsets:
        out.extend(struct.pack("<I", off))
    out.extend(blob)
    return bytes(out)


def patch_android_manifest_axml(axml: bytes) -> bytes:
    """
    1. Rebrands package ID from `com.discord` to `com.discord.botclient`, renames
       all global permissions, ContentProvider authorities, and taskAffinities
       from `com.discord.*` to `com.discord.botclient.*`, and sets the app
       display label to `DiscordBotClient` so it installs and runs side-by-side
       with the official Discord app without any conflict.
    2. Strips split-APK enforcement attributes and Play split metadata from binary
       `AndroidManifest.xml` so Android PackageManager installs the merged APK
       cleanly as a standalone single APK.
    """
    xml_type, xml_hsz, xml_sz = struct.unpack_from("<HHI", axml, 0)
    assert xml_type == 0x0003 and xml_hsz == 8

    strings: list[str] = []
    res_ids: list[int] = []
    app_label_idx: int = -1

    MANIFEST_STRING_REPLACEMENTS = {
        "com.discord": "com.discord.botclient",
        "com.discord.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION": "com.discord.botclient.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
        "com.discord.SentryInitProvider": "com.discord.botclient.SentryInitProvider",
        "com.discord.SentryPerformanceProvider": "com.discord.botclient.SentryPerformanceProvider",
        "com.discord.androidx-startup": "com.discord.botclient.androidx-startup",
        "com.discord.custom_tab_host": "com.discord.botclient.custom_tab_host",
        "com.discord.file-provider": "com.discord.botclient.file-provider",
        "com.discord.fileprovider": "com.discord.botclient.fileprovider",
        "com.discord.firebaseinitprovider": "com.discord.botclient.firebaseinitprovider",
        "com.discord.imagepickerprovider": "com.discord.botclient.imagepickerprovider",
        "com.discord.provider": "com.discord.botclient.provider",
        "com.discord.share": "com.discord.botclient.share",
    }

    STRIP_MANIFEST_RES_IDS = {
        0x01010591,  # android:isSplitRequired
        0x0101064E,  # android:requiredSplitTypes
        0x0101064F,  # android:splitTypes
    }
    STRIP_MANIFEST_ATTR_NAMES = {"isSplitRequired", "requiredSplitTypes", "splitTypes"}

    STRIP_METADATA_NAMES = {
        "com.android.vending.splits.required",
        "com.android.vending.splits",
        "com.android.vending.derived.apk.id",
        "com.android.stamp.source",
        "com.android.stamp.type",
        "com.android.dynamic.apk.fused.modules",
    }

    out_chunks = bytearray()
    pos = xml_hsz
    skip_next_end_element = False

    while pos < len(axml):
        ct, chsz, csz = struct.unpack_from("<HHI", axml, pos)
        chunk = axml[pos : pos + csz]
        pos += csz

        if ct == 0x0001:  # RES_STRING_POOL_TYPE
            orig_strings = parse_utf16_axml_string_pool(chunk, 0)
            strings = [MANIFEST_STRING_REPLACEMENTS.get(s, s) for s in orig_strings]
            app_label_idx = len(strings)
            strings.append("DiscordBotClient")
            out_chunks.extend(build_utf16_string_pool(strings))
        elif ct == 0x0180:  # RES_XML_RESOURCE_MAP_TYPE
            cnt = (csz - chsz) // 4
            res_ids = [struct.unpack_from("<I", chunk, chsz + i * 4)[0] for i in range(cnt)]
            out_chunks.extend(chunk)
        elif ct == 0x0102:  # RES_XML_START_ELEMENT_TYPE
            ns_idx, name_idx, attr_start, attr_size, attr_count, id_idx, cls_idx, style_idx = struct.unpack_from(
                "<iiHHHHHH", chunk, 16
            )
            elem_name = strings[name_idx] if 0 <= name_idx < len(strings) else ""

            if elem_name in ("manifest", "application", "activity", "activity-alias"):
                kept_attrs = []
                attrs_base = 16 + attr_start
                for ai in range(attr_count):
                    a_off = attrs_base + ai * attr_size
                    attr_bytes = bytearray(chunk[a_off : a_off + attr_size])
                    a_ns_idx, a_name_idx, _, a_tsize, a_res0, _, _ = struct.unpack_from("<iiiHBBI", attr_bytes, 0)
                    a_name = strings[a_name_idx] if 0 <= a_name_idx < len(strings) else ""
                    a_res = res_ids[a_name_idx] if 0 <= a_name_idx < len(res_ids) else 0
                    if elem_name in ("manifest", "application") and (
                        a_res in STRIP_MANIFEST_RES_IDS or a_name in STRIP_MANIFEST_ATTR_NAMES
                    ):
                        continue
                    # Override android:label (0x01010001) to "DiscordBotClient" on <application>, <activity>, <activity-alias>
                    if a_res == 0x01010001 and app_label_idx >= 0:
                        struct.pack_into(
                            "<iiiHBBI",
                            attr_bytes,
                            0,
                            a_ns_idx,
                            a_name_idx,
                            app_label_idx,
                            a_tsize,
                            a_res0,
                            0x03,  # TYPE_STRING
                            app_label_idx,
                        )
                    kept_attrs.append(bytes(attr_bytes))

                new_chunk_sz = 16 + attr_start + len(kept_attrs) * attr_size
                new_elem = bytearray(chunk[: 16 + attr_start])
                struct.pack_into("<I", new_elem, 4, new_chunk_sz)
                struct.pack_into("<HHHH", new_elem, 28, len(kept_attrs), 0, 0, 0)
                for ab in kept_attrs:
                    new_elem.extend(ab)
                out_chunks.extend(new_elem)
            elif elem_name == "meta-data":
                meta_name = ""
                attrs_base = 16 + attr_start
                for ai in range(attr_count):
                    a_off = attrs_base + ai * attr_size
                    _, a_name_idx, a_raw_idx, _, _, a_dtype, a_data = struct.unpack_from(
                        "<iiiHBBI", chunk, a_off
                    )
                    a_name = strings[a_name_idx] if 0 <= a_name_idx < len(strings) else ""
                    a_res = res_ids[a_name_idx] if 0 <= a_name_idx < len(res_ids) else 0
                    if a_res == 0x01010003 or a_name == "name":
                        if a_dtype == 0x03 and 0 <= a_data < len(strings):
                            meta_name = strings[a_data]
                        elif 0 <= a_raw_idx < len(strings):
                            meta_name = strings[a_raw_idx]
                if meta_name in STRIP_METADATA_NAMES:
                    skip_next_end_element = True
                    continue
                out_chunks.extend(chunk)
            else:
                out_chunks.extend(chunk)
        elif ct == 0x0103:  # RES_XML_END_ELEMENT_TYPE
            if skip_next_end_element:
                skip_next_end_element = False
                continue
            out_chunks.extend(chunk)
        else:
            out_chunks.extend(chunk)

    header = struct.pack("<HHI", 0x0003, 8, 8 + len(out_chunks))
    return header + bytes(out_chunks)


def build_utf8_string_pool(strings: list[str]) -> bytes:
    offsets = []
    blob = bytearray()
    for s in strings:
        offsets.append(len(blob))
        u16_len = len(s.encode("utf-16-le")) // 2
        utf8_bytes = s.encode("utf-8")
        u8_len = len(utf8_bytes)
        if u16_len > 0x7F:
            blob.append(((u16_len >> 8) & 0x7F) | 0x80)
            blob.append(u16_len & 0xFF)
        else:
            blob.append(u16_len)
        if u8_len > 0x7F:
            blob.append(((u8_len >> 8) & 0x7F) | 0x80)
            blob.append(u8_len & 0xFF)
        else:
            blob.append(u8_len)
        blob.extend(utf8_bytes)
        blob.append(0)

    while len(blob) % 4 != 0:
        blob.append(0)

    header_sz = 28
    strings_start = header_sz + 4 * len(strings)
    chunk_sz = strings_start + len(blob)
    out = bytearray(struct.pack("<HHIIIIII", 0x0001, header_sz, chunk_sz, len(strings), 0, 0x100, strings_start, 0))
    for off in offsets:
        out.extend(struct.pack("<I", off))
    out.extend(blob)
    return bytes(out)


def parse_arsc(arsc: bytes):
    g_strings = parse_utf16_axml_string_pool(arsc, 12)
    _, _, g_sz = struct.unpack_from("<HHI", arsc, 12)
    pkg_off = 12 + g_sz
    _, pkg_hsz, pkg_sz, _ = struct.unpack_from("<HHII", arsc, pkg_off)
    pkg_header = bytearray(arsc[pkg_off : pkg_off + pkg_hsz])
    ts_off, last_pub_t, ks_off, last_pub_k = struct.unpack_from("<IIII", pkg_header, 268)

    _, _, ts_sz = struct.unpack_from("<HHI", arsc, pkg_off + ts_off)
    type_pool_raw = arsc[pkg_off + ts_off : pkg_off + ts_off + ts_sz]
    k_strings = parse_utf16_axml_string_pool(arsc, pkg_off + ks_off)
    _, _, ks_sz = struct.unpack_from("<HHI", arsc, pkg_off + ks_off)

    # Group TYPE_SPEC (0x0202) and TYPE (0x0201) chunks by type_id
    specs: dict[int, bytearray] = {}
    types_by_id: dict[int, list[bytearray]] = {}
    type_order: list[int] = []

    p = pkg_off + ks_off + ks_sz
    other_chunks: list[bytes] = []
    while p < pkg_off + pkg_sz:
        ct, chsz, csz = struct.unpack_from("<HHI", arsc, p)
        chunk = bytearray(arsc[p : p + csz])
        p += csz
        if ct == 0x0202:
            tid = chunk[8]
            specs[tid] = chunk
            if tid not in type_order:
                type_order.append(tid)
                types_by_id[tid] = []
        elif ct == 0x0201:
            tid = chunk[8]
            if tid not in type_order:
                type_order.append(tid)
                types_by_id[tid] = []
            types_by_id[tid].append(chunk)
        else:
            other_chunks.append(bytes(chunk))

    return g_strings, pkg_header, type_pool_raw, k_strings, last_pub_t, last_pub_k, type_order, specs, types_by_id, other_chunks


def merge_resources_arsc(base_arsc: bytes, split_arscs: list[bytes]) -> bytes:
    """
    Merges `split_config.xxhdpi.apk` and `split_config.en.apk` `resources.arsc`
    tables into `base.apk`'s `resources.arsc`, remapping all global string refs
    and package key string refs, OR-ing `ResTable_typeSpec` flags, and padding
    trimmed split `ResTable_type` offset arrays to match `base` `entryCount`.
    """
    (
        g_strings,
        pkg_header,
        type_pool_raw,
        k_strings,
        last_pub_t,
        last_pub_k,
        type_order,
        specs,
        types_by_id,
        other_chunks,
    ) = parse_arsc(base_arsc)

    g_index = {s: idx for idx, s in enumerate(g_strings)}
    k_index = {s: idx for idx, s in enumerate(k_strings)}

    def intern_global(s: str) -> int:
        idx = g_index.get(s)
        if idx is None:
            idx = len(g_strings)
            g_strings.append(s)
            g_index[s] = idx
        return idx

    def intern_key(s: str) -> int:
        idx = k_index.get(s)
        if idx is None:
            idx = len(k_strings)
            k_strings.append(s)
            k_index[s] = idx
        return idx

    for sp_arsc in split_arscs:
        sp_g, _, _, sp_k, _, _, sp_order, sp_specs, sp_types, _ = parse_arsc(sp_arsc)

        for tid in sp_order:
            assert tid in specs, f"Split contains unknown type_id {tid}"
            base_spec = specs[tid]
            base_ecnt = struct.unpack_from("<I", base_spec, 12)[0]
            _, base_spec_hsz, _ = struct.unpack_from("<HHI", base_spec, 0)

            # OR spec configuration flags into base TYPE_SPEC
            if tid in sp_specs:
                sp_spec = sp_specs[tid]
                _, sp_spec_hsz, _ = struct.unpack_from("<HHI", sp_spec, 0)
                sp_ecnt = struct.unpack_from("<I", sp_spec, 12)[0]
                for ei in range(min(base_ecnt, sp_ecnt)):
                    b_flag = struct.unpack_from("<I", base_spec, base_spec_hsz + ei * 4)[0]
                    s_flag = struct.unpack_from("<I", sp_spec, sp_spec_hsz + ei * 4)[0]
                    struct.pack_into("<I", base_spec, base_spec_hsz + ei * 4, b_flag | s_flag)

            # Remap and append each RES_TABLE_TYPE chunk
            for tchunk in sp_types[tid]:
                _, chsz, csz = struct.unpack_from("<HHI", tchunk, 0)
                tflags = tchunk[9]
                assert tflags == 0, f"Unexpected ResTable_type flags: 0x{tflags:x}"
                ecnt, estart = struct.unpack_from("<II", tchunk, 12)

                # Remap key indices and TYPE_STRING global string indices in entry data
                for ei in range(ecnt):
                    e_rel = struct.unpack_from("<I", tchunk, chsz + ei * 4)[0]
                    if e_rel == 0xFFFFFFFF:
                        continue
                    epos = estart + e_rel
                    esize, eflags, ekey = struct.unpack_from("<HHI", tchunk, epos)
                    new_key = intern_key(sp_k[ekey])
                    struct.pack_into("<I", tchunk, epos + 4, new_key)

                    if eflags & 0x01:  # FLAG_COMPLEX (ResTable_map_entry)
                        _, map_cnt = struct.unpack_from("<II", tchunk, epos + 8)
                        mpos = epos + esize
                        for _ in range(map_cnt):
                            v_dtype = tchunk[mpos + 7]
                            v_data = struct.unpack_from("<I", tchunk, mpos + 8)[0]
                            if v_dtype == 0x03:  # TYPE_STRING
                                struct.pack_into("<I", tchunk, mpos + 8, intern_global(sp_g[v_data]))
                            mpos += 12
                    else:  # Simple ResTable_entry + Res_value
                        vpos = epos + esize
                        v_dtype = tchunk[vpos + 3]
                        v_data = struct.unpack_from("<I", tchunk, vpos + 4)[0]
                        if v_dtype == 0x03:  # TYPE_STRING
                            struct.pack_into("<I", tchunk, vpos + 4, intern_global(sp_g[v_data]))

                # Pad offset table with NO_ENTRY (0xFFFFFFFF) if split trimmed trailing empty entries
                if ecnt < base_ecnt:
                    pad_count = base_ecnt - ecnt
                    pad_bytes = b"\xff\xff\xff\xff" * pad_count
                    new_estart = estart + len(pad_bytes)
                    new_csz = csz + len(pad_bytes)
                    rebuilt = bytearray()
                    rebuilt.extend(tchunk[:estart])
                    rebuilt.extend(pad_bytes)
                    rebuilt.extend(tchunk[estart:])
                    struct.pack_into("<I", rebuilt, 4, new_csz)
                    struct.pack_into("<II", rebuilt, 12, base_ecnt, new_estart)
                    tchunk = rebuilt

                types_by_id[tid].append(tchunk)

    new_global_pool = build_utf8_string_pool(g_strings)
    new_key_pool = build_utf8_string_pool(k_strings)

    pkg_body = bytearray()
    ts_rel_off = len(pkg_header)
    pkg_body.extend(type_pool_raw)
    ks_rel_off = len(pkg_header) + len(pkg_body)
    pkg_body.extend(new_key_pool)

    for tid in type_order:
        pkg_body.extend(specs[tid])
        for tchunk in types_by_id[tid]:
            pkg_body.extend(tchunk)
    for oc in other_chunks:
        pkg_body.extend(oc)

    total_pkg_sz = len(pkg_header) + len(pkg_body)
    pkg_name_u16 = "com.discord.botclient".encode("utf-16-le").ljust(256, b"\x00")
    pkg_header[12:268] = pkg_name_u16
    struct.pack_into("<I", pkg_header, 4, total_pkg_sz)
    struct.pack_into("<IIII", pkg_header, 268, ts_rel_off, last_pub_t, ks_rel_off, len(k_strings))

    total_arsc_sz = 12 + len(new_global_pool) + total_pkg_sz
    table_header = struct.pack("<HHII", 0x0002, 12, total_arsc_sz, 1)
    return table_header + new_global_pool + bytes(pkg_header) + bytes(pkg_body)


def compute_apk_v2_chunk_digest(sections: list[bytes]) -> bytes:
    chunk_size = 1024 * 1024
    chunk_digests = []
    for section in sections:
        offset = 0
        n = len(section)
        while offset < n:
            chunk = section[offset : offset + chunk_size]
            h = hashlib.sha256()
            h.update(b"\xa5")
            h.update(struct.pack("<I", len(chunk)))
            h.update(chunk)
            chunk_digests.append(h.digest())
            offset += chunk_size

    top = hashlib.sha256()
    top.update(b"\x5a")
    top.update(struct.pack("<I", len(chunk_digests)))
    for d in chunk_digests:
        top.update(d)
    return top.digest()


def lp_bytes(data: bytes) -> bytes:
    return struct.pack("<I", len(data)) + data


def sign_apk_v2(unsigned_apk: Path, signed_apk: Path) -> None:
    raw = unsigned_apk.read_bytes()
    eocd_pos = raw.rfind(b"PK\x05\x06")
    if eocd_pos < 0:
        raise RuntimeError("Invalid ZIP: EOCD not found")

    cd_offset = struct.unpack_from("<I", raw, eocd_pos + 16)[0]
    before_cd = raw[:cd_offset]
    cd = raw[cd_offset:eocd_pos]
    eocd = bytearray(raw[eocd_pos:])

    key_file = ROOT / "dist/debug_signing_key.pem"
    cert_file = ROOT / "dist/debug_signing_cert.der"
    if key_file.exists() and cert_file.exists():
        key = serialization.load_pem_private_key(key_file.read_bytes(), password=None)
        cert_der = cert_file.read_bytes()
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name(
            [
                x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Revenge BotClient"),
                x509.NameAttribute(NameOID.COMMON_NAME, "DiscordBotClient Android"),
            ]
        )
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .sign(key, hashes.SHA256())
        )
        cert_der = cert.public_bytes(serialization.Encoding.DER)
        key_file.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        cert_file.write_bytes(cert_der)

    pub_key_der = key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    digest = compute_apk_v2_chunk_digest([before_cd, cd, bytes(eocd)])
    sig_algo = 0x0103  # RSA_PKCS1_V1_5_WITH_SHA256
    digests_seq = lp_bytes(lp_bytes(struct.pack("<I", sig_algo) + lp_bytes(digest)))
    certificates_seq = lp_bytes(lp_bytes(cert_der))
    additional_attrs_seq = lp_bytes(b"")
    signed_data = digests_seq + certificates_seq + additional_attrs_seq

    signature_bytes = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA256())
    signatures_seq = lp_bytes(lp_bytes(struct.pack("<I", sig_algo) + lp_bytes(signature_bytes)))
    signer = lp_bytes(lp_bytes(signed_data) + signatures_seq + lp_bytes(pub_key_der))
    signers_block = lp_bytes(signer)

    pair = struct.pack("<I", 0x7109871A) + signers_block
    pairs = bytearray(struct.pack("<Q", len(pair)) + pair)

    # Pad pairs to 4096-byte multiple using standard VERITY_PADDING_BLOCK_ID (0x42726577)
    rem = (len(pairs) + 24) % 4096
    if rem != 0:
        pad_total = 4096 - rem
        if pad_total < 12:
            pad_total += 4096
        pad_val_len = pad_total - 12
        pad_pair = struct.pack("<I", 0x42726577) + (b"\x00" * pad_val_len)
        pairs.extend(struct.pack("<Q", len(pad_pair)) + pad_pair)

    block_size_field = len(pairs) + 8 + 16
    sig_block = (
        struct.pack("<Q", block_size_field)
        + bytes(pairs)
        + struct.pack("<Q", block_size_field)
        + b"APK Sig Block 42"
    )

    new_cd_offset = cd_offset + len(sig_block)
    struct.pack_into("<I", eocd, 16, new_cd_offset)
    signed_apk.write_bytes(before_cd + sig_block + cd + bytes(eocd))


def is_signature_entry(name: str) -> bool:
    if name == "stamp-cert-sha256":
        return True
    if name.startswith("META-INF/"):
        upper = name.upper()
        if upper == "META-INF/MANIFEST.MF" or upper.endswith((".SF", ".RSA", ".DSA", ".EC", ".MF")):
            return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Build standalone DiscordBotClient Android APK")
    parser.add_argument("--splits-dir", type=Path, default=ROOT / "apk-build/orig-splits")
    parser.add_argument("--work-dir", type=Path, default=ROOT / "apk-build/standalone-work")
    parser.add_argument("--bundle", type=Path, default=ROOT / "dist/revenge.bundle")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/DiscordBotClient-Android.apk")
    args = parser.parse_args()

    splits_dir: Path = args.splits_dir.resolve()
    work_dir: Path = args.work_dir.resolve()
    bundle_path: Path = args.bundle.resolve()
    output_apk: Path = args.output.resolve()

    aapt2 = resolve_build_tool("aapt2")
    zipalign = resolve_build_tool("zipalign")
    dexdump = resolve_build_tool("dexdump")

    assert bundle_path.exists(), f"Missing {bundle_path} — run `bun run build` first"
    work_dir.mkdir(parents=True, exist_ok=True)
    output_apk.parent.mkdir(parents=True, exist_ok=True)

    base_apk = splits_dir / "base.apk"
    arm64_apk = splits_dir / "split_config.arm64_v8a.apk"
    xxhdpi_apk = splits_dir / "split_config.xxhdpi.apk"
    en_apk = splits_dir / "split_config.en.apk"

    with zipfile.ZipFile(base_apk, "r") as z_base:
        orig_dex3 = z_base.read("classes3.dex")
        orig_manifest = z_base.read("AndroidManifest.xml")
        orig_arsc = z_base.read("resources.arsc")

    with zipfile.ZipFile(xxhdpi_apk, "r") as z_xx:
        xx_arsc = z_xx.read("resources.arsc")

    with zipfile.ZipFile(en_apk, "r") as z_en:
        en_arsc = z_en.read("resources.arsc")

    print("[1/5] Patching classes3.dex (ReactInstance.loadJSBundle -> assets://bundle)...")
    patched_dex3 = patch_classes3_dex(orig_dex3)
    dex3_out = work_dir / "classes3_patched.dex"
    dex3_out.write_bytes(patched_dex3)
    dex_check = subprocess.run(
        [str(dexdump), "-f", "-d", str(dex3_out)],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
        errors="replace",
    )
    assert "com.facebook.react.runtime.ReactInstance.loadJSBundle:(" in dex_check.stdout
    print(f"      Verified classes3_patched.dex with dexdump ({len(patched_dex3):,} bytes)")

    print("[2/5] Patching binary AndroidManifest.xml (removing split enforcement)...")
    patched_manifest = patch_android_manifest_axml(orig_manifest)
    (work_dir / "AndroidManifest.xml").write_bytes(patched_manifest)

    print("[3/5] Merging resources.arsc (base + split_config.xxhdpi + split_config.en)...")
    merged_arsc = merge_resources_arsc(orig_arsc, [xx_arsc, en_arsc])
    (work_dir / "resources.arsc").write_bytes(merged_arsc)
    print(f"      Merged resources.arsc ({len(merged_arsc):,} bytes)")

    print("[4/5] Assembling merged unaligned APK...")
    unaligned_apk = work_dir / "unaligned.apk"
    seen_entries: set[str] = set()

    def write_entry(zf_out: zipfile.ZipFile, name: str, data: bytes, compress_type: int) -> None:
        if name in seen_entries:
            return
        seen_entries.add(name)
        zi = zipfile.ZipInfo(filename=name, date_time=(2026, 1, 1, 0, 0, 0))
        zi.compress_type = compress_type
        zi.create_system = 3
        zi.external_attr = 0o644 << 16
        if compress_type == zipfile.ZIP_STORED:
            zf_out.writestr(zi, data, compress_type=zipfile.ZIP_STORED)
        else:
            zf_out.writestr(zi, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)

    revenge_bytes = bundle_path.read_bytes()

    with zipfile.ZipFile(unaligned_apk, "w") as z_out:
        # Mandatory uncompressed entries first
        write_entry(z_out, "AndroidManifest.xml", patched_manifest, zipfile.ZIP_DEFLATED)
        write_entry(z_out, "resources.arsc", merged_arsc, zipfile.ZIP_STORED)
        write_entry(z_out, "classes3.dex", patched_dex3, zipfile.ZIP_DEFLATED)

        # Embed Revenge + DiscordBotClient Hermes bytecode bundle (both assets/bundle and assets/revenge.bundle)
        write_entry(z_out, "assets/bundle", revenge_bytes, zipfile.ZIP_STORED)
        write_entry(z_out, "assets/revenge.bundle", revenge_bytes, zipfile.ZIP_STORED)

        # Copy all base.apk entries
        with zipfile.ZipFile(base_apk, "r") as z_base:
            for info in z_base.infolist():
                if info.is_dir() or is_signature_entry(info.filename) or info.filename in seen_entries:
                    continue
                ctype = zipfile.ZIP_STORED if info.compress_type == zipfile.ZIP_STORED else zipfile.ZIP_DEFLATED
                write_entry(z_out, info.filename, z_base.read(info.filename), ctype)

        # Copy all arm64-v8a native libraries as ZIP_STORED (required for extractNativeLibs="false")
        with zipfile.ZipFile(arm64_apk, "r") as z_arm:
            for info in z_arm.infolist():
                if info.is_dir() or is_signature_entry(info.filename) or info.filename in seen_entries:
                    continue
                if info.filename.startswith("lib/"):
                    write_entry(z_out, info.filename, z_arm.read(info.filename), zipfile.ZIP_STORED)

        # Copy all xxhdpi drawable resources
        with zipfile.ZipFile(xxhdpi_apk, "r") as z_xx:
            for info in z_xx.infolist():
                if (
                    info.is_dir()
                    or is_signature_entry(info.filename)
                    or info.filename == "resources.arsc"
                    or info.filename == "AndroidManifest.xml"
                    or info.filename in seen_entries
                ):
                    continue
                ctype = zipfile.ZIP_STORED if info.compress_type == zipfile.ZIP_STORED else zipfile.ZIP_DEFLATED
                write_entry(z_out, info.filename, z_xx.read(info.filename), ctype)

    # Validate merged APK with aapt2 dump badging and xmltree
    badging_dump = subprocess.run(
        [str(aapt2), "dump", "badging", str(unaligned_apk)],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
        errors="replace",
    )
    assert "package: name='com.discord.botclient'" in badging_dump.stdout
    assert "application-label:'DiscordBotClient'" in badging_dump.stdout
    xml_dump = subprocess.run(
        [str(aapt2), "dump", "xmltree", str(unaligned_apk), "--file", "AndroidManifest.xml"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
        errors="replace",
    )
    assert "requiredSplitTypes" not in xml_dump.stdout
    assert "com.android.vending.splits.required" not in xml_dump.stdout
    assert 'package="com.discord.botclient"' in xml_dump.stdout
    print(f"      Verified merged APK manifest & resources with aapt2 ({unaligned_apk.stat().st_size:,} bytes)")

    print("[5/5] Aligning (16 KB page alignment) and signing (APK Signature Scheme v2)...")
    aligned_apk = work_dir / "aligned.apk"
    subprocess.run([str(zipalign), "-P", "16", "-f", "4", str(unaligned_apk), str(aligned_apk)], check=True)
    subprocess.run([str(zipalign), "-c", "-P", "16", "4", str(aligned_apk)], check=True)

    sign_apk_v2(aligned_apk, output_apk)
    print(f"[+] Standalone APK ready: {output_apk} ({output_apk.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
