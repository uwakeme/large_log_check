/**
 * 日志文件编码检测与解码标签映射。
 *
 * 设计约束:零新依赖。Node/Electron 官方发行版自带全量 ICU,WHATWG TextDecoder
 * 开箱支持 gb18030(GBK 的超集,兼容 GB2312)/utf-16le/utf-16be。
 *
 * 检测策略(对文件头 64KB 裸字节做一次):
 *   1. BOM 优先:EF BB BF → UTF-8;FF FE → UTF-16 LE;FE FF → UTF-16 BE。
 *      (FF FE 后跟 00 00 是 UTF-32 LE 的 BOM,按 UTF-16 LE 近似处理 — UTF-32 日志实际不存在)
 *   2. 无 BOM:用 fatal UTF-8 严格试解,通过 → UTF-8。GBK 中文文本几乎不可能
 *      恰好构成合法 UTF-8 多字节序列,误判率极低;64KB 边界截断的多字节序列
 *      用 stream:true 缓冲,不会误报。纯 ASCII 是所有编码的公共子集,归入 UTF-8。
 *   3. 其余 → GBK(解码时用 gb18030 解码器)。
 *   4. 无 BOM 的 UTF-16 不做自动识别(真实场景里 PowerShell 重定向产物都带 BOM),
 *      需要时由用户在界面手动切换。
 *
 * BOM 剥离不需要手工处理:TextDecoder 默认(ignoreBOM:false)会跳过流首 BOM。
 */

/** 支持的文件编码。展示名用 encodingDisplayName,解码标签用 decoderLabel。 */
export type FileEncoding = 'utf-8' | 'gbk' | 'utf-16le' | 'utf-16be';

/** 检测结果:编码 + 文件头是否有 BOM(BOM 对解码无影响,仅供展示与守卫提示)。 */
export interface DetectedEncoding {
    encoding: FileEncoding;
    hasBom: boolean;
}

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

/** 对文件头字节做编码检测(纯函数,便于单测)。 */
export function detectEncoding(buf: Buffer): DetectedEncoding {
    if (buf.subarray(0, 3).equals(BOM_UTF8)) {
        return { encoding: 'utf-8', hasBom: true };
    }
    if (buf.subarray(0, 2).equals(BOM_UTF16LE)) {
        return { encoding: 'utf-16le', hasBom: true };
    }
    if (buf.subarray(0, 2).equals(BOM_UTF16BE)) {
        return { encoding: 'utf-16be', hasBom: true };
    }
    if (isStrictUtf8(buf)) {
        return { encoding: 'utf-8', hasBom: false };
    }
    return { encoding: 'gbk', hasBom: false };
}

/** 严格 UTF-8 试解:出现任何非法字节即抛错 → 判为非 UTF-8。 */
function isStrictUtf8(buf: Buffer): boolean {
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        // stream:true — 结尾被截断的多字节序列先缓冲,不因截断误报非法
        decoder.decode(buf, { stream: true });
        return true;
    } catch {
        return false;
    }
}

/** 编码 → WHATWG TextDecoder 标签。GBK 用超集 gb18030 解码器。 */
export function decoderLabel(encoding: FileEncoding): string {
    switch (encoding) {
        case 'utf-8': return 'utf-8';
        case 'gbk': return 'gb18030';
        case 'utf-16le': return 'utf-16le';
        case 'utf-16be': return 'utf-16be';
    }
}

/** 运行时校验:消息/设置项里的编码字符串是否合法(面板消息入口用)。 */
export function isFileEncoding(v: unknown): v is FileEncoding {
    return v === 'utf-8' || v === 'gbk' || v === 'utf-16le' || v === 'utf-16be';
}

/** 编码 → 用户可见的展示名(界面徽章 / 错误提示用)。 */
export function encodingDisplayName(encoding: FileEncoding): string {
    switch (encoding) {
        case 'utf-8': return 'UTF-8';
        case 'gbk': return 'GBK';
        case 'utf-16le': return 'UTF-16 LE';
        case 'utf-16be': return 'UTF-16 BE';
    }
}
