#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Define memory file path using environment variable with fallback
const defaultMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');

// If MEMORY_FILE_PATH is just a filename, put it in the same directory as the script
const MEMORY_FILE_PATH = process.env.MEMORY_FILE_PATH
  ? path.isAbsolute(process.env.MEMORY_FILE_PATH)
    ? process.env.MEMORY_FILE_PATH
    : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH)
  : defaultMemoryPath;

// We are storing our memory using entities, relations, and observations in a graph structure
interface Entity {
  name: string;
  entityType: string;
  observations: string[];
  metadata?: Metadata;  // Making metadata optional for backward compatibility
}

interface Relation {
  from: string;
  to: string;
  relationType: string;
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// Extended interfaces for lesson learning
interface Metadata {
  createdAt: string;
  updatedAt: string;
  environment?: {
    os?: string;
    nodeVersion?: string;
    dependencies?: Record<string, string>;
  };
  severity?: 'low' | 'medium' | 'high' | 'critical';
  frequency?: number;
  successRate?: number;
}

interface ErrorPattern {
  type: string;
  message: string;
  context: string;
  stackTrace?: string;
}

interface VerificationStep {
  command: string;
  expectedOutput: string;
  successIndicators: string[];
}

interface LessonEntity extends Entity {
  errorPattern: ErrorPattern;
  metadata: Metadata;
  verificationSteps: VerificationStep[];
}

// File management interfaces
interface FileInfo {
  path: string;
  type: 'memory' | 'lesson';
  sequence: number;
  lineCount: number;
  lastModified: string;
}

interface FileRegistry {
  files: FileInfo[];
  lastUpdated: string;
}

// Cache management
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  hits: number;
}

class CacheManager {
  private cache: Map<string, CacheEntry<any>>;
  private maxEntries: number = 1000;
  private ttl: number = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.cache = new Map();
  }

  private cleanOldEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  private ensureCapacity(): void {
    if (this.cache.size >= this.maxEntries) {
      // Remove least accessed entries
      const entries = Array.from(this.cache.entries())
        .sort(([, a], [, b]) => a.hits - b.hits)
        .slice(0, Math.floor(this.maxEntries * 0.2)); // Remove 20% of entries

      for (const [key] of entries) {
        this.cache.delete(key);
      }
    }
  }

  set<T>(key: string, value: T): void {
    this.cleanOldEntries();
    this.ensureCapacity();

    this.cache.set(key, {
      data: value,
      timestamp: Date.now(),
      hits: 0
    });
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    entry.hits++;
    entry.timestamp = now;
    return entry.data as T;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

// FileManager class to handle split files
class FileManager {
  private registryPath: string;
  private maxLinesPerFile: number = 1000;

  constructor() {
    this.registryPath = path.join(path.dirname(MEMORY_FILE_PATH), 'file_registry.json');
  }

  private async loadRegistry(): Promise<FileRegistry> {
    try {
      const data = await fs.readFile(this.registryPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
        // Initialize with both memory.json and lesson.json
        const memoryPath = path.join(path.dirname(MEMORY_FILE_PATH), 'memory.json');
        const lessonPath = path.join(path.dirname(MEMORY_FILE_PATH), 'lesson.json');

        return {
          files: [
            {
              path: memoryPath,
              type: 'memory',
              sequence: 1,
              lineCount: 0,
              lastModified: new Date().toISOString()
            },
            {
              path: lessonPath,
              type: 'lesson',
              sequence: 1,
              lineCount: 0,
              lastModified: new Date().toISOString()
            }
          ],
          lastUpdated: new Date().toISOString()
        };
      }
      throw error;
    }
  }

  private async saveRegistry(registry: FileRegistry): Promise<void> {
    // Ensure all paths are relative
    const registryDir = path.dirname(this.registryPath);
    const updatedFiles = registry.files.map(file => ({
      ...file,
      path: path.isAbsolute(file.path) ? path.relative(registryDir, file.path) : file.path
    }));

    await fs.writeFile(
      this.registryPath,
      JSON.stringify({ ...registry, files: updatedFiles }, null, 2)
    );
  }

  private async countLines(filePath: string): Promise<number> {
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return data.split('\n').filter(line => line.trim() !== '').length;
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  private async shouldSplitFile(fileInfo: FileInfo): Promise<boolean> {
    const lineCount = await this.countLines(fileInfo.path);
    return lineCount >= this.maxLinesPerFile;
  }

  private getNextFilePath(currentPath: string, sequence: number): string {
    const dir = path.dirname(currentPath);
    const ext = path.extname(currentPath);
    const baseName = path.basename(currentPath, ext);
    const baseWithoutSeq = baseName.replace(/-\d+$/, '');
    return path.join(dir, `${baseWithoutSeq}-${sequence}${ext}`);
  }

  async getFilesForEntityType(entityType: string): Promise<string[]> {
    const registry = await this.loadRegistry();
    const registryDir = path.dirname(this.registryPath);
    const type = entityType === 'lesson' ? 'lesson' : 'memory';

    return registry.files
      .filter(f => f.type === type)
      .map(f => path.isAbsolute(f.path) ? f.path : path.join(registryDir, f.path));
  }

  async splitFileIfNeeded(fileInfo: FileInfo): Promise<FileInfo[]> {
    if (!await this.shouldSplitFile(fileInfo)) {
      return [fileInfo];
    }

    const data = await fs.readFile(fileInfo.path, 'utf-8');
    const lines = data.split('\n').filter(line => line.trim() !== '');
    const chunks: string[][] = [];

    for (let i = 0; i < lines.length; i += this.maxLinesPerFile) {
      chunks.push(lines.slice(i, i + this.maxLinesPerFile));
    }

    const newFiles: FileInfo[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const newPath = this.getNextFilePath(fileInfo.path, i + 1);
      await fs.writeFile(newPath, chunks[i].join('\n'));

      newFiles.push({
        path: newPath,
        type: fileInfo.type,
        sequence: i + 1,
        lineCount: chunks[i].length,
        lastModified: new Date().toISOString()
      });
    }

    return newFiles;
  }

  async updateRegistry(): Promise<void> {
    const registry = await this.loadRegistry();

    // Update line counts and check for splits
    const updatedFiles: FileInfo[] = [];
    for (const file of registry.files) {
      const lineCount = await this.countLines(file.path);
      if (lineCount >= this.maxLinesPerFile) {
        const splitFiles = await this.splitFileIfNeeded(file);
        updatedFiles.push(...splitFiles);
      } else {
        updatedFiles.push({
          ...file,
          lineCount,
          lastModified: new Date().toISOString()
        });
      }
    }

    registry.files = updatedFiles;
    registry.lastUpdated = new Date().toISOString();
    await this.saveRegistry(registry);
  }
}

// Transaction management
interface Transaction {
  id: string;
  operations: Array<{
    type: 'write' | 'delete';
    file: string;
    data?: string;
    timestamp: number;
  }>;
  status: 'pending' | 'committed' | 'rolled_back';
  startTime: number;
  endTime?: number;
}

class TransactionManager {
  private transactionLogPath: string;
  private activeTransactions: Map<string, Transaction>;
  private backupDir: string;

  constructor() {
    this.transactionLogPath = path.join(path.dirname(MEMORY_FILE_PATH), 'transaction.log');
    this.backupDir = path.join(path.dirname(MEMORY_FILE_PATH), 'backups');
    this.activeTransactions = new Map();
  }

  private async ensureBackupDir(): Promise<void> {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
    } catch (error) {
      // Directory already exists
    }
  }

  private async createBackup(filePath: string): Promise<string> {
    await this.ensureBackupDir();
    const backupPath = path.join(
      this.backupDir,
      `${path.basename(filePath)}.${Date.now()}.bak`
    );

    try {
      await fs.copyFile(filePath, backupPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code !== 'ENOENT') {
        throw error;
      }
    }

    return backupPath;
  }

  private async logTransaction(transaction: Transaction): Promise<void> {
    const logEntry = JSON.stringify({
      ...transaction,
      timestamp: Date.now()
    }) + '\n';

    await fs.appendFile(this.transactionLogPath, logEntry);
  }

  async beginTransaction(): Promise<string> {
    const transactionId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const transaction: Transaction = {
      id: transactionId,
      operations: [],
      status: 'pending',
      startTime: Date.now()
    };

    this.activeTransactions.set(transactionId, transaction);
    await this.logTransaction(transaction);
    return transactionId;
  }

  async addOperation(
    transactionId: string,
    type: 'write' | 'delete',
    file: string,
    data?: string
  ): Promise<void> {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction || transaction.status !== 'pending') {
      throw new Error(`Invalid transaction: ${transactionId}`);
    }

    // Create backup before first operation on this file
    if (!transaction.operations.some(op => op.file === file)) {
      await this.createBackup(file);
    }

    transaction.operations.push({
      type,
      file,
      data,
      timestamp: Date.now()
    });

    await this.logTransaction(transaction);
  }

  async commitTransaction(transactionId: string): Promise<void> {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction || transaction.status !== 'pending') {
      throw new Error(`Invalid transaction: ${transactionId}`);
    }

    try {
      // Execute all operations in order
      for (const operation of transaction.operations) {
        if (operation.type === 'write' && operation.data) {
          // Ensure directory exists
          await fs.mkdir(path.dirname(operation.file), { recursive: true });

          // Write file atomically
          const tempPath = `${operation.file}.tmp`;
          await fs.writeFile(tempPath, operation.data);
          await fs.rename(tempPath, operation.file);
        } else if (operation.type === 'delete') {
          try {
            await fs.unlink(operation.file);
          } catch (error) {
            if (error instanceof Error && 'code' in error && (error as any).code !== 'ENOENT') {
              throw error;
            }
          }
        }
      }

      transaction.status = 'committed';
      transaction.endTime = Date.now();
      await this.logTransaction(transaction);
    } catch (error) {
      await this.rollbackTransaction(transactionId);
      throw error;
    } finally {
      this.activeTransactions.delete(transactionId);
    }
  }

  async rollbackTransaction(transactionId: string): Promise<void> {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) {
      throw new Error(`Invalid transaction: ${transactionId}`);
    }

    // Restore backups for all modified files
    const processedFiles = new Set<string>();
    for (const operation of transaction.operations) {
      if (processedFiles.has(operation.file)) continue;

      const backups = await fs.readdir(this.backupDir);
      const relevantBackup = backups
        .filter(b => b.startsWith(path.basename(operation.file)))
        .sort()
        .pop();

      if (relevantBackup) {
        const backupPath = path.join(this.backupDir, relevantBackup);
        await fs.copyFile(backupPath, operation.file);
      }

      processedFiles.add(operation.file);
    }

    transaction.status = 'rolled_back';
    transaction.endTime = Date.now();
    await this.logTransaction(transaction);
    this.activeTransactions.delete(transactionId);
  }

  async recover(): Promise<void> {
    try {
      const logContent = await fs.readFile(this.transactionLogPath, 'utf-8');
      const transactions = logContent
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as Transaction);

      // Find incomplete transactions
      const pendingTransactions = transactions.filter(tx => tx.status === 'pending');

      // Rollback all pending transactions
      for (const transaction of pendingTransactions) {
        this.activeTransactions.set(transaction.id, transaction);
        await this.rollbackTransaction(transaction.id);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
class KnowledgeGraphManager {
  private fileManager: FileManager;
  private cache: CacheManager;
  private transactionManager: TransactionManager;

  constructor() {
    this.fileManager = new FileManager();
    this.cache = new CacheManager();
    this.transactionManager = new TransactionManager();
  }

  private getCacheKey(operation: string, params: any = {}): string {
    return `${operation}:${JSON.stringify(params)}`;
  }

  private async loadGraph(): Promise<KnowledgeGraph> {
    const cacheKey = this.getCacheKey('loadGraph');
    const cached = this.cache.get<KnowledgeGraph>(cacheKey);
    if (cached) return cached;

    try {
      const graph: KnowledgeGraph = { entities: [], relations: [] };

      const memoryFiles = await this.fileManager.getFilesForEntityType('memory');
      const lessonFiles = await this.fileManager.getFilesForEntityType('lesson');
      const allFiles = [...memoryFiles, ...lessonFiles];

      for (const filePath of allFiles) {
        const data = await fs.readFile(filePath, 'utf-8');
        const lines = data.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          const item = JSON.parse(line);
          if (item.type === 'entity') graph.entities.push(item as Entity);
          if (item.type === 'relation') graph.relations.push(item as Relation);
        }
      }

      this.cache.set(cacheKey, graph);
      return graph;
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
        const emptyGraph = { entities: [], relations: [] };
        this.cache.set(cacheKey, emptyGraph);
        return emptyGraph;
      }
      throw error;
    }
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const transactionId = await this.transactionManager.beginTransaction();

    try {
      // Invalidate cache
      this.cache.clear();

      // Split entities by type
      const lessons = graph.entities.filter(e => e.entityType === 'lesson');
      const otherEntities = graph.entities.filter(e => e.entityType !== 'lesson');

      // Prepare data for each file type
      const lessonLines = lessons.map(e => JSON.stringify({ type: 'entity', ...e }));
      const entityLines = otherEntities.map(e => JSON.stringify({ type: 'entity', ...e }));
      const relationLines = graph.relations.map(r => JSON.stringify({ type: 'relation', ...r }));

      // Get appropriate files for each type
      const [lessonFile] = await this.fileManager.getFilesForEntityType('lesson');
      const [memoryFile] = await this.fileManager.getFilesForEntityType('memory');

      // Add operations to transaction
      if (lessonLines.length > 0) {
        const lessonFilePath = lessonFile || path.join(path.dirname(MEMORY_FILE_PATH), 'lesson.json');
        await this.transactionManager.addOperation(
          transactionId,
          'write',
          lessonFilePath,
          lessonLines.join('\n')
        );
      }

      await this.transactionManager.addOperation(
        transactionId,
        'write',
        memoryFile,
        [...entityLines, ...relationLines].join('\n')
      );

      // Commit transaction
      await this.transactionManager.commitTransaction(transactionId);

      // Update file registry after successful commit
      await this.fileManager.updateRegistry();
    } catch (error) {
      await this.transactionManager.rollbackTransaction(transactionId);
      throw error;
    }
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const newEntities = entities.filter(e => !graph.entities.some(existingEntity => existingEntity.name === e.name));
    graph.entities.push(...newEntities);
    await this.saveGraph(graph);
    return newEntities;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const newRelations = relations.filter(r => !graph.relations.some(existingRelation =>
      existingRelation.from === r.from &&
      existingRelation.to === r.to &&
      existingRelation.relationType === r.relationType
    ));
    graph.relations.push(...newRelations);
    await this.saveGraph(graph);
    return newRelations;
  }

  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const graph = await this.loadGraph();
    const results = observations.map(o => {
      const entity = graph.entities.find(e => e.name === o.entityName);
      if (!entity) {
        throw new Error(`Entity with name ${o.entityName} not found`);
      }
      const newObservations = o.contents.filter(content => !entity.observations.includes(content));
      entity.observations.push(...newObservations);
      return { entityName: o.entityName, addedObservations: newObservations };
    });
    await this.saveGraph(graph);
    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
    graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
    await this.saveGraph(graph);
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    const graph = await this.loadGraph();
    deletions.forEach(d => {
      const entity = graph.entities.find(e => e.name === d.entityName);
      if (entity) {
        entity.observations = entity.observations.filter(o => !d.observations.includes(o));
      }
    });
    await this.saveGraph(graph);
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.relations = graph.relations.filter(r => !relations.some(delRelation =>
      r.from === delRelation.from &&
      r.to === delRelation.to &&
      r.relationType === delRelation.relationType
    ));
    await this.saveGraph(graph);
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  // Very basic search function
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const cacheKey = this.getCacheKey('searchNodes', { query });
    const cached = this.cache.get<KnowledgeGraph>(cacheKey);
    if (cached) return cached;

    const graph = await this.loadGraph();

    const filteredEntities = graph.entities.filter(e =>
      e.name.toLowerCase().includes(query.toLowerCase()) ||
      e.entityType.toLowerCase().includes(query.toLowerCase()) ||
      e.observations.some(o => o.toLowerCase().includes(query.toLowerCase()))
    );

    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    const result = {
      entities: filteredEntities,
      relations: filteredRelations,
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    // Filter entities
    const filteredEntities = graph.entities.filter(e => names.includes(e.name));

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // Filter relations to only include those between filtered entities
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };

    return filteredGraph;
  }

  async createLesson(lesson: LessonEntity): Promise<LessonEntity> {
    // Validate required fields
    if (!lesson.name || !lesson.errorPattern || !lesson.verificationSteps) {
      throw new Error('Missing required fields in lesson');
    }

    // Validate error pattern
    if (!lesson.errorPattern.type || !lesson.errorPattern.message || !lesson.errorPattern.context) {
      throw new Error('Missing required fields in error pattern');
    }

    // Validate verification steps
    if (!lesson.verificationSteps.every(step =>
      step.command && step.expectedOutput && Array.isArray(step.successIndicators)
    )) {
      throw new Error('Invalid verification steps');
    }

    const graph = await this.loadGraph();

    // Check for duplicate lesson
    if (graph.entities.some(e => e.name === lesson.name)) {
      throw new Error(`Lesson with name ${lesson.name} already exists`);
    }

    // Set metadata timestamps and initial values
    lesson.metadata = {
      ...lesson.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      frequency: 0,
      successRate: 0
    };

    // Add to entities
    graph.entities.push(lesson);
    await this.saveGraph(graph);
    return lesson;
  }

  async findSimilarErrors(errorPattern: ErrorPattern): Promise<LessonEntity[]> {
    const graph = await this.loadGraph();

    return graph.entities
      .filter((e): e is LessonEntity => {
        if (e.entityType !== 'lesson') return false;
        const lessonEntity = e as Partial<LessonEntity>;
        return (
          lessonEntity.errorPattern !== undefined &&
          (
            lessonEntity.errorPattern.type === errorPattern.type ||
            lessonEntity.errorPattern.message.toLowerCase().includes(errorPattern.message.toLowerCase()) ||
            lessonEntity.errorPattern.context === errorPattern.context
          )
        );
      })
      .sort((a, b) => (b.metadata?.successRate ?? 0) - (a.metadata?.successRate ?? 0));
  }

  async updateLessonSuccess(lessonName: string, success: boolean): Promise<void> {
    const graph = await this.loadGraph();
    const lesson = graph.entities.find(e => e.name === lessonName && e.entityType === 'lesson') as LessonEntity | undefined;

    if (!lesson) {
      throw new Error(`Lesson with name ${lessonName} not found`);
    }

    if (!lesson.metadata) {
      lesson.metadata = {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        frequency: 0,
        successRate: 0
      };
    }

    const currentSuccessRate = lesson.metadata.successRate ?? 0;
    const frequency = lesson.metadata.frequency ?? 0;

    lesson.metadata.frequency = frequency + 1;
    lesson.metadata.successRate = ((currentSuccessRate * frequency) + (success ? 1 : 0)) / (frequency + 1);
    lesson.metadata.updatedAt = new Date().toISOString();

    await this.saveGraph(graph);
  }

  async getLessonRecommendations(context: string): Promise<LessonEntity[]> {
    const graph = await this.loadGraph();

    return graph.entities
      .filter((e): e is LessonEntity => {
        if (e.entityType !== 'lesson') return false;
        const lessonEntity = e as Partial<LessonEntity>;
        return (
          lessonEntity.errorPattern !== undefined &&
          (
            lessonEntity.errorPattern.type.toLowerCase().includes(context.toLowerCase()) ||
            lessonEntity.errorPattern.message.toLowerCase().includes(context.toLowerCase()) ||
            lessonEntity.errorPattern.context.toLowerCase().includes(context.toLowerCase()) ||
            e.observations.some(o => o.toLowerCase().includes(context.toLowerCase()))
          )
        );
      })
      .sort((a, b) => (b.metadata?.successRate ?? 0) - (a.metadata?.successRate ?? 0));
  }

  async recover(): Promise<void> {
    await this.transactionManager.recover();
  }
}

const knowledgeGraphManager = new KnowledgeGraphManager();


// The server instance and tools exposed to Claude
const server = new Server({
  name: "memory-server",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
},);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_entities",
        description: "Create multiple new entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "The name of the entity" },
                  entityType: { type: "string", description: "The type of the entity" },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents associated with the entity"
                  },
                },
                required: ["name", "entityType", "observations"],
              },
            },
          },
          required: ["entities"],
        },
      },
      {
        name: "create_relations",
        description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "add_observations",
        description: "Add new observations to existing entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            observations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity to add the observations to" },
                  contents: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents to add"
                  },
                },
                required: ["entityName", "contents"],
              },
            },
          },
          required: ["observations"],
        },
      },
      {
        name: "delete_entities",
        description: "Delete multiple entities and their associated relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entityNames: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to delete"
            },
          },
          required: ["entityNames"],
        },
      },
      {
        name: "delete_observations",
        description: "Delete specific observations from entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            deletions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: { type: "string", description: "The name of the entity containing the observations" },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observations to delete"
                  },
                },
                required: ["entityName", "observations"],
              },
            },
          },
          required: ["deletions"],
        },
      },
      {
        name: "delete_relations",
        description: "Delete multiple relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string", description: "The name of the entity where the relation starts" },
                  to: { type: "string", description: "The name of the entity where the relation ends" },
                  relationType: { type: "string", description: "The type of the relation" },
                },
                required: ["from", "to", "relationType"],
              },
              description: "An array of relations to delete"
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "read_graph",
        description: "Read the entire knowledge graph",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_nodes",
        description: "Search for nodes in the knowledge graph based on a query",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query to match against entity names, types, and observation content" },
          },
          required: ["query"],
        },
      },
      {
        name: "open_nodes",
        description: "Open specific nodes in the knowledge graph by their names",
        inputSchema: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to retrieve",
            },
          },
          required: ["names"],
        },
      },
      {
        name: "create_lesson",
        description: "Create a new lesson from an error and its solution",
        inputSchema: {
          type: "object",
          properties: {
            lesson: {
              type: "object",
              properties: {
                name: { type: "string", description: "Unique identifier for the lesson" },
                entityType: { type: "string", enum: ["lesson"], description: "Must be 'lesson'" },
                observations: {
                  type: "array",
                  items: { type: "string" },
                  description: "List of observations about the error and solution"
                },
                errorPattern: {
                  type: "object",
                  properties: {
                    type: { type: "string", description: "Category of the error" },
                    message: { type: "string", description: "The error message" },
                    context: { type: "string", description: "Where the error occurred" },
                    stackTrace: { type: "string", description: "Optional stack trace" }
                  },
                  required: ["type", "message", "context"]
                },
                metadata: {
                  type: "object",
                  properties: {
                    severity: {
                      type: "string",
                      enum: ["low", "medium", "high", "critical"],
                      description: "Severity level of the error"
                    },
                    environment: {
                      type: "object",
                      properties: {
                        os: { type: "string" },
                        nodeVersion: { type: "string" },
                        dependencies: {
                          type: "object",
                          additionalProperties: { type: "string" }
                        }
                      }
                    }
                  }
                },
                verificationSteps: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      command: { type: "string", description: "Command to run" },
                      expectedOutput: { type: "string", description: "Expected output" },
                      successIndicators: {
                        type: "array",
                        items: { type: "string" },
                        description: "Indicators of success"
                      }
                    },
                    required: ["command", "expectedOutput", "successIndicators"]
                  }
                }
              },
              required: ["name", "entityType", "observations", "errorPattern", "verificationSteps"]
            }
          },
          required: ["lesson"]
        }
      },
      {
        name: "find_similar_errors",
        description: "Find similar errors and their solutions in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            errorPattern: {
              type: "object",
              properties: {
                type: { type: "string", description: "Category of the error" },
                message: { type: "string", description: "The error message" },
                context: { type: "string", description: "Where the error occurred" }
              },
              required: ["type", "message", "context"]
            }
          },
          required: ["errorPattern"]
        }
      },
      {
        name: "update_lesson_success",
        description: "Update the success rate of a lesson after applying its solution",
        inputSchema: {
          type: "object",
          properties: {
            lessonName: { type: "string", description: "Name of the lesson to update" },
            success: { type: "boolean", description: "Whether the solution was successful" }
          },
          required: ["lessonName", "success"]
        }
      },
      {
        name: "get_lesson_recommendations",
        description: "Get relevant lessons based on the current context",
        inputSchema: {
          type: "object",
          properties: {
            context: {
              type: "string",
              description: "The current context to find relevant lessons for"
            }
          },
          required: ["context"]
        }
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  switch (name) {
    case "create_entities":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createEntities(args.entities as Entity[]), null, 2) }] };
    case "create_relations":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createRelations(args.relations as Relation[]), null, 2) }] };
    case "add_observations":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.addObservations(args.observations as { entityName: string; contents: string[] }[]), null, 2) }] };
    case "delete_entities":
      await knowledgeGraphManager.deleteEntities(args.entityNames as string[]);
      return { content: [{ type: "text", text: "Entities deleted successfully" }] };
    case "delete_observations":
      await knowledgeGraphManager.deleteObservations(args.deletions as { entityName: string; observations: string[] }[]);
      return { content: [{ type: "text", text: "Observations deleted successfully" }] };
    case "delete_relations":
      await knowledgeGraphManager.deleteRelations(args.relations as Relation[]);
      return { content: [{ type: "text", text: "Relations deleted successfully" }] };
    case "read_graph":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.readGraph(), null, 2) }] };
    case "search_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.searchNodes(args.query as string), null, 2) }] };
    case "open_nodes":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.openNodes(args.names as string[]), null, 2) }] };
    case "create_lesson":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createLesson(args.lesson as LessonEntity), null, 2) }] };
    case "find_similar_errors":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.findSimilarErrors(args.errorPattern as ErrorPattern), null, 2) }] };
    case "update_lesson_success":
      await knowledgeGraphManager.updateLessonSuccess(args.lessonName as string, args.success as boolean);
      return { content: [{ type: "text", text: "Lesson success updated successfully" }] };
    case "get_lesson_recommendations":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.getLessonRecommendations(args.context as string), null, 2) }] };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Initialize recovery on startup
async function main() {
  await knowledgeGraphManager.recover();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
