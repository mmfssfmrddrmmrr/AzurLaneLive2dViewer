export type shipSkin = {
    "id": number;
    "name": string;
    "ship_name": string;
    "prefab": string;
    "url": string;
    "isLive2d": boolean;
} 
import type { namecodeMap } from "./namecode.js";
import { replaceNameCode } from "./namecode.js";

export function extractShipSkins(lua: string, namecode: namecodeMap) {
    if (Object.keys(namecode).length === 0) console.warn("empty namecodeMap")
    const ship_id_pattern = /ship_group = (\d+)/;
    const skin_name_pattern = /name = "(.*)"/;
    const id_pattern = /\sid = (\d+)/;
    const prefab_pattern = /prefab = "([-\w]+)"/;
    const l2d_id_pattern = /ship_l2d_id = {/

    const all_skins: shipSkin[] = []
    const ship_id2name: Map<number, string> = new Map;
    for (const ship of lua.split("_G")) {
        if (!ship){continue};
        const ship_id = Number(ship.match(ship_id_pattern)![1]);
        const name = ship.match(skin_name_pattern)![1]!;
        if (!ship_id2name.has(ship_id))
            ship_id2name.set(ship_id, name);
        const ship_name = ship_id2name.get(ship_id)!;

        const id = Number(ship.match(id_pattern)![1])
        const prefab = ship.match(prefab_pattern)![1]!
        const isLive2d = Boolean(ship.match(l2d_id_pattern))
        all_skins.push({
            id: id, 
            name: replaceNameCode(name, namecode), 
            ship_name: replaceNameCode(ship_name, namecode), 
            prefab: prefab, 
            url: "", 
            isLive2d: isLive2d
        })
    }
    return all_skins
}

export function universalExtract(lua: string, keys: string[]): Record<string, Record<string, string>> {
    /**
     * keys 示例：["name", "url", ...]
     * 按照每个key，提取/\skey = .../
     */
    // 使用
    const result: Record<string, Record<string, string>> = {};
    const idPattern = /\sid = (\d+)/;
    for (const text of lua.split("{")) {
        console.log(text);
        const obj: Record<string, string> = {};
        const m = text.match(idPattern);
        if (!m) continue
        const id = m[1] ?? "-1";
        for (const key of keys) {
            const pattern = new RegExp(`\\s${key} = "?(.*?)"?,`);
            const match = text.match(pattern);
            obj[key] = match?.[1] ?? "Unknown";
        }
        result[id] = obj;
    }
    return result
}