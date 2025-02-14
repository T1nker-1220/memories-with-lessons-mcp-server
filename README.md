# Knowledge Graph Memory Server
[![smithery badge](https://smithery.ai/badge/@T1nker-1220/memories-with-lessons-mcp-server)](https://smithery.ai/server/@T1nker-1220/memories-with-lessons-mcp-server)

A basic implementation of persistent memory using a local knowledge graph. This lets Claude remember information about the user across chats and learn from past errors through a lesson system.

## Core Concepts

### Entities
Entities are the primary nodes in the knowledge graph. Each entity has:
- A unique name (identifier)
- An entity type (e.g., "person", "organization", "event")
- A list of observations

Example:
```json
{
  "name": "John_Smith",
  "entityType": "person",
  "observations": ["Speaks fluent Spanish"]
}
```

### Relations
Relations define directed connections between entities. They are always stored in active voice and describe how entities interact or relate to each other.

Example:
```json
{
  "from": "John_Smith",
  "to": "Anthropic",
  "relationType": "works_at"
}
```
### Observations
Observations are discrete pieces of information about an entity. They are:

- Stored as strings
- Attached to specific entities
- Can be added or removed independently
- Should be atomic (one fact per observation)

Example:
```json
{
  "entityName": "John_Smith",
  "observations": [
    "Speaks fluent Spanish",
    "Graduated in 2019",
    "Prefers morning meetings"
  ]
}
```

### Lessons
Lessons are special entities that capture knowledge about errors and their solutions. Each lesson has:
- A unique name (identifier)
- Error pattern information (type, message, context)
- Solution steps and verification
- Success rate tracking
- Environmental context
- Metadata (severity, timestamps, frequency)

Example:
```json
{
  "name": "NPM_VERSION_MISMATCH_01",
  "entityType": "lesson",
  "observations": [
    "Error occurs when using incompatible package versions",
    "Affects Windows environments specifically",
    "Resolution requires version pinning"
  ],
  "errorPattern": {
    "type": "dependency",
    "message": "Cannot find package @shadcn/ui",
    "context": "package installation"
  },
  "metadata": {
    "severity": "high",
    "environment": {
      "os": "windows",
      "nodeVersion": "18.x"
    },
    "createdAt": "2025-02-13T13:21:58.523Z",
    "updatedAt": "2025-02-13T13:22:21.336Z",
    "frequency": 1,
    "successRate": 1.0
  },
  "verificationSteps": [
    {
      "command": "pnpm add shadcn@latest",
      "expectedOutput": "Successfully installed shadcn",
      "successIndicators": ["added shadcn"]
    }
  ]
}
```

## API

### Tools
- **create_entities**
  - Create multiple new entities in the knowledge graph
  - Input: `entities` (array of objects)
    - Each object contains:
      - `name` (string): Entity identifier
      - `entityType` (string): Type classification
      - `observations` (string[]): Associated observations
  - Ignores entities with existing names

- **create_relations**
  - Create multiple new relations between entities
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type in active voice
  - Skips duplicate relations

- **add_observations**
  - Add new observations to existing entities
  - Input: `observations` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `contents` (string[]): New observations to add
  - Returns added observations per entity
  - Fails if entity doesn't exist

- **delete_entities**
  - Remove entities and their relations
  - Input: `entityNames` (string[])
  - Cascading deletion of associated relations
  - Silent operation if entity doesn't exist

- **delete_observations**
  - Remove specific observations from entities
  - Input: `deletions` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `observations` (string[]): Observations to remove
  - Silent operation if observation doesn't exist

- **delete_relations**
  - Remove specific relations from the graph
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type
  - Silent operation if relation doesn't exist

- **read_graph**
  - Read the entire knowledge graph
  - No input required
  - Returns complete graph structure with all entities and relations

- **search_nodes**
  - Search for nodes based on query
  - Input: `query` (string)
  - Searches across:
    - Entity names
    - Entity types
    - Observation content
  - Returns matching entities and their relations

- **open_nodes**
  - Retrieve specific nodes by name
  - Input: `names` (string[])
  - Returns:
    - Requested entities
    - Relations between requested entities
  - Silently skips non-existent nodes

### Lesson Management Tools
- **create_lesson**
  - Create a new lesson from an error and its solution
  - Input: `lesson` (object)
    - Contains:
      - `name` (string): Unique identifier
      - `entityType` (string): Must be "lesson"
      - `observations` (string[]): Notes about the error and solution
      - `errorPattern` (object): Error details
        - `type` (string): Category of error
        - `message` (string): Error message
        - `context` (string): Where error occurred
        - `stackTrace` (string, optional): Stack trace
      - `metadata` (object): Additional information
        - `severity` ("low" | "medium" | "high" | "critical")
        - `environment` (object): System details
        - `frequency` (number): Times encountered
        - `successRate` (number): Solution success rate
      - `verificationSteps` (array): Solution verification
        - Each step contains:
          - `command` (string): Action to take
          - `expectedOutput` (string): Expected result
          - `successIndicators` (string[]): Success markers
  - Automatically initializes metadata timestamps
  - Validates all required fields

- **find_similar_errors**
  - Find similar errors and their solutions
  - Input: `errorPattern` (object)
    - Contains:
      - `type` (string): Error category
      - `message` (string): Error message
      - `context` (string): Error context
  - Returns matching lessons sorted by success rate
  - Uses fuzzy matching for error messages

- **update_lesson_success**
  - Update success tracking for a lesson
  - Input:
    - `lessonName` (string): Lesson to update
    - `success` (boolean): Whether solution worked
  - Updates:
    - Success rate (weighted average)
    - Frequency counter
    - Last update timestamp

- **get_lesson_recommendations**
  - Get relevant lessons for current context
  - Input: `context` (string)
  - Searches across:
    - Error type
    - Error message
    - Error context
    - Lesson observations
  - Returns lessons sorted by:
    - Context relevance
    - Success rate
  - Includes full solution details

## File Management
The server now handles two types of files:
- `memory.json`: Stores basic entities and relations
- `lesson.json`: Stores lesson entities with error patterns

Files are automatically split if they exceed 1000 lines to maintain performance.

## Cursor MCP Client Setup

To integrate this memory server with Cursor MCP client, follow these steps:

1. Clone the Repository:
```bash
git clone [repository-url]
cd [repository-name]
```

2. Install Dependencies:
```bash
pnpm install
```

3. Build the Project:
```bash
pnpm build
```

4. Configure the Server:
- Locate the full path to the built server file: `/path/to/the/dist/index.js`
- Start the server using Node.js: `node /path/to/the/dist/index.js`

5. Activate in Cursor:
- Use the keyboard shortcut `Ctrl+Shift+P`
- Type "reload window" and select it
- Wait a few seconds for the MCP server to activate
- Select the stdio type when prompted

The memory server should now be integrated with your Cursor MCP client and ready to use.


# Usage with Claude Desktop

### Setup

Add this to your claude_desktop_config.json:

#### Docker

```json
{
  "mcpServers": {
    "memory": {
      "command": "docker",
      "args": ["run", "-i", "-v", "claude-memory:/app/dist", "--rm", "mcp/memory"]
    }
  }
}
```

#### NPX
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ]
    }
  }
}
```

#### NPX with custom setting

The server can be configured using the following environment variables:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.json"
      }
    }
  }
}
```

- `MEMORY_FILE_PATH`: Path to the memory storage JSON file (default: `memory.json` in the server directory)

### System Prompt

The prompt for utilizing memory depends on the use case. Changing the prompt will help the model determine the frequency and types of memories created.

Here is an example prompt for chat personalization. You could use this prompt in the "Custom Instructions" field of a [Claude.ai Project](https://www.anthropic.com/news/projects).

```
Follow these steps for each interaction:

1. User Identification:
   - You should assume that you are interacting with default_user
   - If you have not identified default_user, proactively try to do so.

2. Memory Retrieval:
   - Always begin your chat by saying only "Remembering..." and retrieve all relevant information from your knowledge graph
   - Always refer to your knowledge graph as your "memory"

3. Memory
   - While conversing with the user, be attentive to any new information that falls into these categories:
     a) Basic Identity (age, gender, location, job title, education level, etc.)
     b) Behaviors (interests, habits, etc.)
     c) Preferences (communication style, preferred language, etc.)
     d) Goals (goals, targets, aspirations, etc.)
     e) Relationships (personal and professional relationships up to 3 degrees of separation)

4. Memory Update:
   - If any new information was gathered during the interaction, update your memory as follows:
     a) Create entities for recurring organizations, people, and significant events
     b) Connect them to the current entities using relations
     b) Store facts about them as observations
```

## Building

Docker:

```sh
docker build -t mcp/memory -f src/memory/Dockerfile .
```

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.

## New Tools

- **create_lesson**
  - Create a new lesson from an error and its solution
  - Input: `lesson` (object)
    - Contains error pattern, solution steps, and metadata
    - Automatically tracks creation time and updates
    - Verifies solution steps are complete

- **find_similar_errors**
  - Find similar errors and their solutions
  - Input: `errorPattern` (object)
    - Contains error type, message, and context
    - Returns matching lessons sorted by success rate
    - Includes related solutions and verification steps

- **update_lesson_success**
  - Update success tracking for a lesson
  - Input:
    - `lessonName` (string): Lesson to update
    - `success` (boolean): Whether solution worked
  - Updates success rate and frequency metrics

- **get_lesson_recommendations**
  - Get relevant lessons for current context
  - Input: `context` (string)
  - Returns lessons sorted by relevance and success rate
  - Includes full solution details and verification steps


# BIG CREDITS TO THE OWNER OF THIS REPO FOR THE BASE CODE I ENHANCED IT WITH LESSONS AND FILE MANAGEMENT
Big thanks!
https://github.com/modelcontextprotocol/servers
jerome3o-anthropic
https://github.com/modelcontextprotocol/servers/tree/main/src/memory
