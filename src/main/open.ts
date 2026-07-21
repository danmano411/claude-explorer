import { shell } from 'electron'
export async function openPath(path: string): Promise<void> {
  const err = await shell.openPath(path) // '' on success
  if (err) throw new Error(err)
}
export function revealPath(path: string): void {
  shell.showItemInFolder(path)
}
