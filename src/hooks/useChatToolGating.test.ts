import { describe, it, expect } from 'vitest';
import { isRemoteOrPastedLog, shouldEnableLocalFileToolsInFastChat } from './useChat';

describe('useChat tool gating heuristics', () => {
  it('correctly detects remote logs and docker sessions', () => {
    const dockerLog = `pi@pi:~$ docker logs -f --tail 20 rgsx_downloader
2026-11-01 15:30:09,376 - WARNING - Fichier /config/rom_extensions.json vide ou introuvable
No connection adapters were found for 'rgsx+torrent://download?source=https%3A%2F%2Fretrogamesets.fr'`;

    expect(isRemoteOrPastedLog(dockerLog)).toBe(true);
    expect(isRemoteOrPastedLog('root@server:~# journalctl -u nginx')).toBe(true);
    expect(isRemoteOrPastedLog('docker exec -it app bash')).toBe(true);
    expect(isRemoteOrPastedLog('user@vps:~$ ls -la')).toBe(true);
  });

  it('rejects local file tools when remote logs are pasted', () => {
    const dockerLog = `pi@pi:~$ docker logs -f --tail 20 rgsx_downloader
2026-11-01 15:30:09,376 - WARNING - Fichier /config/rom_extensions.json vide ou introuvable`;

    expect(shouldEnableLocalFileToolsInFastChat(dockerLog)).toBe(false);
  });

  it('enables local file tools when the user explicitly requests local files', () => {
    expect(shouldEnableLocalFileToolsInFastChat('find my resume pdf in downloads')).toBe(true);
    expect(shouldEnableLocalFileToolsInFastChat('search for file report.docx')).toBe(true);
    expect(shouldEnableLocalFileToolsInFastChat('list files in ~/Documents')).toBe(true);
    expect(shouldEnableLocalFileToolsInFastChat('read file /Users/admin/notes.txt')).toBe(true);
  });

  it('keeps local file tools disabled for general chat and questions', () => {
    expect(shouldEnableLocalFileToolsInFastChat('write me a python script to download torrents')).toBe(false);
    expect(shouldEnableLocalFileToolsInFastChat('what is the capital of France?')).toBe(false);
    expect(shouldEnableLocalFileToolsInFastChat('how does Docker networking work?')).toBe(false);
  });
});
