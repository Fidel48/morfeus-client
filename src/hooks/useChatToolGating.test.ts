import { describe, it, expect } from 'vitest';
import {
  isRemoteOrPastedLog,
  shouldEnableLocalFileToolsInFastChat,
  isMcpServerRelevant,
  isMandatoryWebSearchQuery,
  extractCleanSearchQuery,
  buildContextualSearchQuery,
} from './useChat';

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

  it('identifies mandatory real-time web_search queries (prices, weather, news, regulations, explicit search)', () => {
    // Live crypto / stock / index / asset prices
    expect(isMandatoryWebSearchQuery('Can you tell me what is the current price of bitcoin')).toBe(true);
    expect(isMandatoryWebSearchQuery('what is the price of BTC right now?')).toBe(true);
    expect(isMandatoryWebSearchQuery('how much is 1 ethereum worth today?')).toBe(true);
    expect(isMandatoryWebSearchQuery('nvidia stock price')).toBe(true);
    expect(isMandatoryWebSearchQuery('what is the s&p 500 trading at today?')).toBe(true);

    // Weather & breaking news & explicit search
    expect(isMandatoryWebSearchQuery("what's the weather in Charlotte right now?")).toBe(true);
    expect(isMandatoryWebSearchQuery('what is the latest news about SpaceX?')).toBe(true);
    expect(isMandatoryWebSearchQuery('search the web for North Carolina insurance licensing updates')).toBe(true);

    // Current officeholders, versions, regulations, and geopolitical/military developments
    expect(isMandatoryWebSearchQuery('who is the current CEO of Intel?')).toBe(true);
    expect(isMandatoryWebSearchQuery('what are the requirements for a North Carolina driver\'s license?')).toBe(true);
    expect(isMandatoryWebSearchQuery('can you tell me the latest news about haiti')).toBe(true);
    expect(isMandatoryWebSearchQuery('an you tell me that lates news in heat?')).toBe(true);
    expect(isMandatoryWebSearchQuery('why did the el salavdor deploy those troops')).toBe(true);
    expect(isMandatoryWebSearchQuery('why did that happen?', true)).toBe(true);
    expect(isMandatoryWebSearchQuery('i am sorry i meant to say haiti', true)).toBe(true);
    expect(isMandatoryWebSearchQuery('sorry i meant ethereum', true)).toBe(true);
    expect(isMandatoryWebSearchQuery('what about in haiti?', true)).toBe(true);
    expect(isMandatoryWebSearchQuery('thanks!', true)).toBe(false);

    // Non-mandatory queries (coding, general knowledge, attached docs, local files)
    expect(isMandatoryWebSearchQuery('write a python script to fetch the current price of bitcoin')).toBe(false);
    expect(isMandatoryWebSearchQuery('what is the capital of France?')).toBe(false);
    expect(isMandatoryWebSearchQuery('Quiz me on the NC Life exam one question at a time')).toBe(false);
    expect(isMandatoryWebSearchQuery('[Attached Document: exam.pdf]\nWhat is the current price of bitcoin?')).toBe(false);
  });

  it('strips conversational filler and enriches follow-up queries & typo corrections with prior search context', () => {
    expect(extractCleanSearchQuery('Can you tell me what is the current price of bitcoin?')).toBe('current price of bitcoin');
    expect(extractCleanSearchQuery('Hey Morfeus, please tell me what is the weather in Miami right now!')).toBe('weather in Miami right now');
    expect(extractCleanSearchQuery('an you tell me that lates news in heat?')).toBe('latest news in heat');
    expect(
      buildContextualSearchQuery('i am sorry i meant to say haiti', ['latest news in heat'])
    ).toBe('latest news in haiti');
    expect(
      buildContextualSearchQuery('sorry i meant ethereum', ['current price of bitcoin'])
    ).toBe('current price of ethereum');
    expect(
      buildContextualSearchQuery('haiti', ['latest news in heat'])
    ).toBe('latest news in haiti');
    expect(
      buildContextualSearchQuery('why did the el salavdor deploy those troops', ['latest news Haiti'])
    ).toBe('why did the el salavdor deploy those troops Haiti');
  });
});
