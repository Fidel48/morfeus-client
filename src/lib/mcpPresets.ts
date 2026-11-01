/**
 * mcpPresets.ts
 *
 * Built-in catalog of standard Model Context Protocol (MCP) servers.
 * Allows users to discover and 1-click install official and community MCP servers
 * without needing external configuration files or Claude Desktop.
 */

export interface McpPreset {
  id: string;
  name: string;
  category: 'core' | 'development' | 'database' | 'cad' | 'web';
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  notes?: string;
  iconName: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    category: 'core',
    description: 'Read and write local files and directories within allowed workspace paths.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    notes: 'Allows Morfeus to safely explore and read project files.',
    iconName: 'FolderOpen',
  },
  {
    id: 'memory',
    name: 'Memory (Knowledge Graph)',
    category: 'core',
    description: 'Persistent knowledge graph that enables the assistant to remember entities and facts across sessions.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    notes: 'Maintains long-term memory about your projects and preferences.',
    iconName: 'Brain',
  },
  {
    id: 'fetch',
    name: 'Web Fetcher',
    category: 'web',
    description: 'Fetches web pages, strips HTML noise, and converts content into clean Markdown for analysis.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    notes: 'Fast, lightweight web scraper for articles and documentation.',
    iconName: 'Globe',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'development',
    description: 'Interact with GitHub repositories, issues, pull requests, commits, and code search.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    notes: 'Requires a GitHub Personal Access Token (PAT) with repo permissions.',
    iconName: 'GitBranch',
  },
  {
    id: 'git',
    name: 'Git Version Control',
    category: 'development',
    description: 'Inspect local Git commits, diffs, status, branches, and staged modifications.',
    command: 'uvx',
    args: ['mcp-server-git'],
    notes: 'Runs natively with uvx to inspect local repositories.',
    iconName: 'GitBranch',
  },
  {
    id: 'sqlite',
    name: 'SQLite Database',
    category: 'database',
    description: 'Inspect database schema, tables, and execute SQL queries against local SQLite files.',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', 'workspace.db'],
    notes: 'Change "workspace.db" to the path of your SQLite file.',
    iconName: 'Database',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL Database',
    category: 'database',
    description: 'Read-only schema inspection and querying for PostgreSQL databases.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    notes: 'Provide your PostgreSQL connection string in the arguments.',
    iconName: 'Database',
  },
  {
    id: 'puppeteer',
    name: 'Browser Automation (Puppeteer)',
    category: 'web',
    description: 'Headless Chromium browser automation, screenshots, page interaction, and JavaScript execution.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    notes: 'Requires Node.js installed on your machine.',
    iconName: 'Globe',
  },
  {
    id: 'freecad',
    name: 'FreeCAD 3D CAD',
    category: 'cad',
    description: 'Parametric 3D CAD design, part generation, geometry manipulation, and code execution in FreeCAD.',
    command: 'uvx',
    args: ['freecad-mcp'],
    env: { FREECAD_MCP_TOKEN: '' },
    notes: 'Requires FreeCAD running with the FreeCAD-MCP addon enabled.',
    iconName: 'Box',
  },
];
