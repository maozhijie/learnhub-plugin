/**
 * 宿主 vault 存储适配层（#175 阶段② / ADR-0044）：VaultFs 端口的真实现——node:fs
 * 的全部落盘/读盘在此收口。engine 侧端口形状住 io.ts、实现住本文件、装配住投递层
 * （createHostRuntime 构造引擎时经 EngineConfig.fs 注入）；R2「engine 禁 import
 * 宿主」自此就是应用→适配器的存储边界。
 */
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import type { VaultFs } from '../engine/index.ts'

export const nodeVaultFs: VaultFs = {
  readFile: path => readFile(path, 'utf8'),
  readFileSync: path => readFileSync(path, 'utf8'),
  exists: path => existsSync(path),
  mkdir: async path => { await mkdir(path, { recursive: true }) },
  readdir: async path => (await readdir(path)).map(String),
  readdirTypes: async path => (await readdir(path, { withFileTypes: true })).map(e => ({ name: e.name, directory: e.isDirectory() })),
  appendFile: (path, data) => appendFile(path, data, 'utf8'),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  unlink: path => unlink(path),
  statIsFile: async path => (await stat(path)).isFile(),
}
