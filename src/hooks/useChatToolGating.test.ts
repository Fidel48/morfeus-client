import { describe, it, expect } from 'vitest';
import { isRemoteOrPastedLog, shouldEnableLocalFileToolsInFastChat, isMcpServerRelevant } from './useChat';

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

  it('correctly gates specialized MCP servers like FreeCAD', () => {
    const freecadServer = { id: 'freecad', name: 'FreeCAD 3D CAD', category: 'cad' };
    const postgresServer = { id: 'postgres', name: 'PostgreSQL Database', category: 'database' };

    // General questions / web searches must NEVER include FreeCAD or Postgres tools
    expect(isMcpServerRelevant(freecadServer, 'what are the rules for the North Carolina DMV road pre-test?')).toBe(false);
    expect(isMcpServerRelevant(freecadServer, 'search the web for weather in Miami')).toBe(false);
    expect(isMcpServerRelevant(postgresServer, 'how do I cook lasagna?')).toBe(false);
    expect(isMcpServerRelevant(freecadServer, 'the official PDF is a bit of a beast')).toBe(false);

    // CAD-related queries MUST include FreeCAD tools
    expect(isMcpServerRelevant(freecadServer, 'create a 3D box in FreeCAD')).toBe(true);
    expect(isMcpServerRelevant(freecadServer, 'extrude this sketch by 15mm')).toBe(true);
    expect(isMcpServerRelevant(freecadServer, 'export part to stl mesh')).toBe(true);
    expect(isMcpServerRelevant(freecadServer, 'what 3d models are in my project?')).toBe(true);

    // Database-related queries MUST include Postgres tools
    expect(isMcpServerRelevant(postgresServer, 'run query on users table in postgres')).toBe(true);
    expect(isMcpServerRelevant(postgresServer, 'show me the sql schema')).toBe(true);

    // Multi-turn context preservation (hasPriorServerCalls)
    expect(isMcpServerRelevant(freecadServer, 'now make it 20mm wider', true)).toBe(true);
  });
});
