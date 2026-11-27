export type namecodeMap = Record<string, {"name": string}>;
const pattern = /\{namecode:(\d+)}/g
export function replaceNameCode(text: string, namecode: namecodeMap) {
    return text.replaceAll(
        pattern,
        (placeHolder, id) => namecode[id]?.name ?? placeHolder
    )
}