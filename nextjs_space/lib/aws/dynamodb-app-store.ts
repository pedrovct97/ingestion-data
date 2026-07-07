import {
  AttributeValue,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';
import {
  createDynamoDBClient,
  getDynamoDBConfig,
  getManualIngestionConfig,
  isAwsConfigured,
} from '../aws-config';

// Registro de tabela manual. Estes dados sao lidos/escritos no DynamoDB que a
// Lambda de ingestao manual consulta para descobrir data_schema e paths S3.
export interface PipelineConfigRecord {
  id: string;
  tableName: string;
  displayName: string;
  requiredColumns: string;
  s3Prefix: string;
  description: string | null;
  sourceType: string;
  existsInDynamo: boolean;
  isActive: boolean;
  manualIngestionEnabled: boolean;
  appManaged: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Registro unificado de execucao. Upload manual, reprocessamento API e
// calendario usam a mesma tabela para historico e monitoramento.
export interface ExecutionHistoryRecord {
  id: string;
  tableName: string;
  fileName: string;
  fileSize: number | null;
  status: string;
  sourceType: string;
  startTime: Date;
  endTime: Date | null;
  executionArn: string | null;
  duration: number | null;
  errors: string | null;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const mockPipelineConfigs: PipelineConfigRecord[] = [];
const mockExecutions: ExecutionHistoryRecord[] = [];
function s(value?: string | null): AttributeValue {
  return { S: value || '' };
}

function n(value?: number | null): AttributeValue {
  return { N: String(value ?? 0) };
}

function b(value?: boolean | null): AttributeValue {
  return { BOOL: Boolean(value) };
}

function readString(item: Record<string, AttributeValue>, key: string, fallback = '') {
  return item[key]?.S ?? fallback;
}

function readNumber(item: Record<string, AttributeValue>, key: string): number | null {
  const value = item[key]?.N;
  return value === undefined ? null : Number(value);
}

function readBoolean(item: Record<string, AttributeValue>, key: string, fallback = false) {
  return item[key]?.BOOL ?? fallback;
}

function readDate(item: Record<string, AttributeValue>, key: string, fallback?: string) {
  return new Date(readString(item, key, fallback || new Date().toISOString()));
}

function nullable(value: string) {
  return value || null;
}

function configTableName() {
  const { configTable } = getDynamoDBConfig();
  if (!configTable) throw new Error('AWS_DYNAMODB_CONFIG_TABLE não configurada');
  return configTable;
}

function manualIngestionConfig() {
  const config = getManualIngestionConfig();
  const missing = [
    ['MANUAL_INGESTION_ORIGIN_PREFIX', config.originPrefix],
    ['MANUAL_INGESTION_DESTINATION_BUCKET', config.destinationBucket],
    ['MANUAL_INGESTION_DESTINATION_PREFIX', config.destinationPrefix],
    ['MANUAL_INGESTION_PROCESSING_TYPE', config.processingType],
    ['MANUAL_INGESTION_TYPE_PROCESS', config.typeProcess],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} não configurada(s)`);
  }

  return config;
}

// Monta o origin_path no mesmo formato esperado pela Lambda de ingestao manual.
function normalizePrefix(value: string, fallback: string) {
  return (value || fallback).replace(/^\/+/, '').replace(/\/?$/, '/');
}

function normalizePathForCompare(value?: string | null) {
  return String(value || '').trim().replace(/^s3:\/\/[^/]+\//, '').replace(/^\/+/, '').toLowerCase();
}

function visibleManualOriginPrefixes() {
  const configured = manualIngestionConfig().visibleOriginPrefix || 'ingestion_cts/';
  return configured
    .split(',')
    .map((prefix) => normalizePathForCompare(prefix).replace(/\/?$/, '/'))
    .filter(Boolean);
}

function isVisibleManualIngestionConfig(config: PipelineConfigRecord) {
  const originPath = normalizePathForCompare(config.s3Prefix || config.id);
  const prefixes = visibleManualOriginPrefixes();
  return prefixes.length === 0 || prefixes.some((prefix) => originPath.startsWith(prefix));
}

function buildOriginPath(tableName: string) {
  const prefix = normalizePrefix('', manualIngestionConfig().originPrefix);
  return `${prefix}${tableName}/`;
}

function resolveOriginPath(tableName: string, s3Prefix?: string | null) {
  const value = s3Prefix?.trim();
  if (value && value !== `${tableName}/`) {
    return normalizePrefix(value, buildOriginPath(tableName));
  }
  return buildOriginPath(tableName);
}

function configOriginPath(config: PipelineConfigRecord) {
  if (config.id?.endsWith('/')) return config.id;
  if (config.s3Prefix?.endsWith('/')) return config.s3Prefix;
  return buildOriginPath(config.tableName);
}

function buildDestinationPath(tableName: string) {
  const prefix = normalizePrefix('', manualIngestionConfig().destinationPrefix);
  return `${prefix}${tableName}/`;
}

function tableNameFromOriginPath(originPath: string) {
  return originPath.replace(/\/+$/, '').split('/').pop() || originPath;
}

function normalizeLookup(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

function itemMatchesTableName(item: Record<string, AttributeValue>, tableName: string) {
  const target = normalizeLookup(tableName);
  const originPath = readString(item, 'origin_path');
  return [
    readString(item, 'dataset_name'),
    readString(item, 'table_name'),
    readString(item, 'display_name'),
    tableNameFromOriginPath(originPath),
  ].some((value) => normalizeLookup(value) === target);
}

function columnsJsonToMap(columnsJson: string): Record<string, AttributeValue> {
  try {
    const columns = JSON.parse(columnsJson || '[]');
    if (!Array.isArray(columns)) return {};

    return Object.fromEntries(
      columns
        .map((column) => [String(column.name || '').trim(), { S: String(column.type || 'string') }])
        .filter(([name]) => Boolean(name))
    );
  } catch {
    return {};
  }
}

function buildConfigUpdateExpression(
  data: Partial<Pick<
    PipelineConfigRecord,
    | 'requiredColumns'
    | 'manualIngestionEnabled'
  >>,
  existing?: PipelineConfigRecord
) {
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const sets: string[] = [];

  if (data.requiredColumns !== undefined) {
    const oldColumns = parseColumnsFromConfig(existing?.requiredColumns || '[]');
    const oldByName = new Map(oldColumns.map((column) => [column.name, column.type]));
    const nextColumns = parseColumnsFromConfig(data.requiredColumns);

    names['#data_schema'] = 'data_schema';
    nextColumns.forEach((column, index) => {
      if (oldByName.get(column.name) === column.type) return;

      const nameToken = `#column${index}`;
      const valueToken = `:columnType${index}`;
      names[nameToken] = column.name;
      values[valueToken] = s(column.type);
      sets.push(`#data_schema.${nameToken} = ${valueToken}`);
    });
  }

  if (data.manualIngestionEnabled !== undefined) {
    names['#manual_ingestion_enabled'] = 'manual_ingestion_enabled';
    values[':manualIngestionEnabled'] = b(data.manualIngestionEnabled);
    sets.push('#manual_ingestion_enabled = :manualIngestionEnabled');
  }

  return {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

function parseColumnsFromConfig(columnsJson: string): { name: string; type: string }[] {
  try {
    const columns = JSON.parse(columnsJson || '[]');
    if (!Array.isArray(columns)) return [];

    return columns
      .map((column) => ({
        name: String(column.name || '').trim(),
        type: String(column.type || 'string').trim().toLowerCase(),
      }))
      .filter((column) => Boolean(column.name));
  } catch {
    return [];
  }
}

// Converte o item DynamoDB real para o formato que as telas entendem.
// O schema exibido na aplicacao vem somente do atributo map data_schema.
function schemaMapToColumnsJson(schema?: Record<string, AttributeValue>) {
  if (!schema) return '[]';
  return JSON.stringify(
    Object.entries(schema).map(([name, value]) => ({
      name,
      type: value.S || 'string',
    }))
  );
}

function executionTableName() {
  const { executionHistoryTable } = getDynamoDBConfig();
  if (!executionHistoryTable) {
    throw new Error('AWS_DYNAMODB_EXECUTION_HISTORY_TABLE não configurada');
  }
  return executionHistoryTable;
}

function mapConfigItem(item: Record<string, AttributeValue>): PipelineConfigRecord {
  const originPath = readString(item, 'origin_path');
  const tableName =
    readString(item, 'dataset_name') ||
    readString(item, 'table_name') ||
    tableNameFromOriginPath(originPath);
  const createdAt = readDate(item, 'created_at');
  const updatedAt = readDate(item, 'updated_at', createdAt.toISOString());

  return {
    id: originPath || readString(item, 'id') || tableName,
    tableName,
    displayName:
      readString(item, 'display_name') ||
      readString(item, 'description') ||
      tableName.replace(/_/g, ' '),
    requiredColumns: schemaMapToColumnsJson(item.data_schema?.M),
    s3Prefix: originPath || readString(item, 's3_prefix') || buildOriginPath(tableName),
    description: nullable(readString(item, 'description')),
    sourceType: readString(item, 'source_type', 'file'),
    existsInDynamo: readBoolean(item, 'exists_in_dynamo', true),
    isActive: readBoolean(item, 'is_active', true),
    manualIngestionEnabled: readBoolean(item, 'manual_ingestion_enabled', true),
    appManaged: readBoolean(item, 'app_managed', false),
    createdAt,
    updatedAt,
  };
}

function toConfigItem(config: PipelineConfigRecord): Record<string, AttributeValue> {
  const originPath = resolveOriginPath(config.tableName, config.s3Prefix);
  const manualConfig = manualIngestionConfig();
  const now = new Date().toISOString();

  return {
    origin_path: s(originPath),
    arn_name: s(''),
    dataset_name: s(config.tableName),
    data_schema: { M: columnsJsonToMap(config.requiredColumns) },
    destination_bucket: s(manualConfig.destinationBucket),
    destination_path: s(buildDestinationPath(config.tableName)),
    load_full: b(manualConfig.loadFull),
    processing_type: s(manualConfig.processingType),
    topic_sns: s(''),
    type_process: s(manualConfig.typeProcess),
    id: s(config.id || originPath),
    table_name: s(config.tableName),
    display_name: s(config.displayName),
    s3_prefix: s(originPath),
    description: s(config.description),
    source_type: s(config.sourceType),
    exists_in_dynamo: b(config.existsInDynamo),
    is_active: b(config.isActive),
    manual_ingestion_enabled: b(config.manualIngestionEnabled),
    app_managed: b(config.appManaged),
    created_at: s(config.createdAt?.toISOString() || now),
    updated_at: s(config.updatedAt?.toISOString() || now),
  };
}

// Converte o item DynamoDB de historico para datas/numero nativos do JS.
// As telas recebem este formato e adicionam o objeto "user" quando necessario.
function mapExecutionItem(item: Record<string, AttributeValue>): ExecutionHistoryRecord {
  const createdAt = readDate(item, 'created_at');
  const startTime = readDate(item, 'start_time', createdAt.toISOString());

  return {
    id: readString(item, 'id'),
    tableName: readString(item, 'table_name'),
    fileName: readString(item, 'file_name'),
    fileSize: readNumber(item, 'file_size'),
    status: readString(item, 'status'),
    sourceType: readString(item, 'source_type', 'file'),
    startTime,
    endTime: nullable(readString(item, 'end_time')) ? readDate(item, 'end_time') : null,
    executionArn: nullable(readString(item, 'execution_arn')),
    duration: readNumber(item, 'duration'),
    errors: nullable(readString(item, 'errors')),
    userId: nullable(readString(item, 'user_id')),
    userEmail: nullable(readString(item, 'user_email')),
    userName: nullable(readString(item, 'user_name')),
    createdAt,
    updatedAt: readDate(item, 'updated_at', createdAt.toISOString()),
  };
}

function toExecutionItem(execution: ExecutionHistoryRecord): Record<string, AttributeValue> {
  return {
    id: s(execution.id),
    table_name: s(execution.tableName),
    file_name: s(execution.fileName),
    file_size: n(execution.fileSize),
    status: s(execution.status),
    source_type: s(execution.sourceType),
    start_time: s(execution.startTime.toISOString()),
    end_time: s(execution.endTime?.toISOString()),
    execution_arn: s(execution.executionArn),
    duration: n(execution.duration),
    errors: s(execution.errors),
    user_id: s(execution.userId),
    user_email: s(execution.userEmail),
    user_name: s(execution.userName),
    created_at: s(execution.createdAt.toISOString()),
    updated_at: s(execution.updatedAt.toISOString()),
  };
}

async function scanAll(tableName: string) {
  const client = createDynamoDBClient();
  const items: Record<string, AttributeValue>[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await client.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    items.push(...((response.Items || []) as Record<string, AttributeValue>[]));
    ExclusiveStartKey = response.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (ExclusiveStartKey);

  return items;
}

// Lista configuracoes de tabelas exibidas em /tabelas e usadas pelo upload.
// O filtro sourceType separa tabelas manuais de outros tipos de origem.
export async function listPipelineConfigs(params: {
  sourceType?: string;
  activeOnly?: boolean;
  manualIngestionOnly?: boolean;
} = {}) {
  if (!isAwsConfigured()) {
    return mockPipelineConfigs
      .filter((config) => !params.sourceType || params.sourceType !== 'file' || isVisibleManualIngestionConfig(config))
      .filter((config) => !params.activeOnly || config.isActive)
      .filter((config) => !params.sourceType || config.sourceType === params.sourceType)
      .filter((config) => !params.manualIngestionOnly || config.manualIngestionEnabled)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  const configs = (await scanAll(configTableName())).map(mapConfigItem);
  return configs
    .filter((config) => !params.sourceType || params.sourceType !== 'file' || isVisibleManualIngestionConfig(config))
    .filter((config) => !params.activeOnly || config.isActive)
    .filter((config) => !params.sourceType || config.sourceType === params.sourceType)
    .filter((config) => !params.manualIngestionOnly || config.manualIngestionEnabled)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// Busca por nome tecnico da tabela usando a chave real do DynamoDB: origin_path.
export async function getPipelineConfigByTableName(tableName: string) {
  if (!isAwsConfigured()) {
    return mockPipelineConfigs.find((config) => config.tableName === tableName) || null;
  }

  const response = await createDynamoDBClient().send(
    new GetItemCommand({
      TableName: configTableName(),
      Key: { origin_path: s(buildOriginPath(tableName)) },
    })
  );

  if (response.Item) {
    return mapConfigItem(response.Item as Record<string, AttributeValue>);
  }

  const configs = await scanAll(configTableName());
  const fallback = configs.find((item) =>
    itemMatchesTableName(item as Record<string, AttributeValue>, tableName)
  );
  return fallback ? mapConfigItem(fallback as Record<string, AttributeValue>) : null;
}

// Aceita tanto origin_path completo quanto nome tecnico. Isso facilita editar
// registros que vieram do Dynamo antigo e novos registros criados pela UI.
export async function getPipelineConfigById(id: string) {
  if (id.endsWith('/')) {
    if (!isAwsConfigured()) {
      return mockPipelineConfigs.find((config) => config.id === id || config.s3Prefix === id) || null;
    }

    const response = await createDynamoDBClient().send(
      new GetItemCommand({
        TableName: configTableName(),
        Key: { origin_path: s(id) },
      })
    );

    if (response.Item) {
      return mapConfigItem(response.Item as Record<string, AttributeValue>);
    }

    const normalize = (value?: string | null) => String(value || '').trim().toLowerCase();
    const target = normalize(id);
    const configs = (await scanAll(configTableName())).map(mapConfigItem);
    return configs.find((config) =>
      [
        config.id,
        config.s3Prefix,
      ].some((value) => normalize(value) === target)
    ) || null;
  }

  const byTableName = await getPipelineConfigByTableName(id);
  if (byTableName) return byTableName;

  const normalize = (value?: string | null) => String(value || '').trim().toLowerCase();
  const target = normalize(id);

  if (!isAwsConfigured()) {
    return mockPipelineConfigs.find((config) =>
      [
        config.id,
        config.tableName,
        config.displayName,
        config.s3Prefix,
      ].some((value) => normalize(value) === target)
    ) || null;
  }

  const configs = (await scanAll(configTableName())).map(mapConfigItem);
  return configs.find((config) =>
    [
      config.id,
      config.tableName,
      config.displayName,
      config.s3Prefix,
    ].some((value) => normalize(value) === target)
  ) || null;
}

// Cria um cadastro de tabela manual. A ConditionExpression evita sobrescrever
// sem querer uma tabela ja existente no DynamoDB do cliente.
export async function createPipelineConfig(input: {
  tableName: string;
  displayName: string;
  requiredColumns: string;
  s3Prefix: string;
  description?: string | null;
  sourceType?: string;
  existsInDynamo?: boolean;
  isActive?: boolean;
  manualIngestionEnabled?: boolean;
}) {
  const existing = await getPipelineConfigByTableName(input.tableName);
  if (existing) return existing;

  const now = new Date();
  const config: PipelineConfigRecord = {
    id: buildOriginPath(input.tableName),
    tableName: input.tableName,
    displayName: input.displayName,
    requiredColumns: input.requiredColumns,
    s3Prefix: resolveOriginPath(input.tableName, input.s3Prefix),
    description: input.description || null,
    sourceType: input.sourceType || 'file',
    existsInDynamo: Boolean(input.existsInDynamo),
    isActive: input.isActive ?? true,
    manualIngestionEnabled: input.manualIngestionEnabled ?? true,
    appManaged: true,
    createdAt: now,
    updatedAt: now,
  };

  if (!isAwsConfigured()) {
    mockPipelineConfigs.push(config);
    return config;
  }

  await createDynamoDBClient().send(
    new PutItemCommand({
      TableName: configTableName(),
      Item: toConfigItem(config),
      ConditionExpression: 'attribute_not_exists(origin_path)',
    })
  );
  return config;
}

// Atualiza schema/descricao/display name da tabela. O PutItem regrava o item
// completo preservando os campos de template esperados pela Lambda.
export async function updatePipelineConfig(
  id: string,
  data: Partial<Pick<
    PipelineConfigRecord,
    | 'requiredColumns'
    | 'description'
    | 'displayName'
    | 'existsInDynamo'
    | 'manualIngestionEnabled'
  >>
) {
  const existing = await getPipelineConfigById(id);
  if (!existing) return null;
  const allowedData = {
    ...(data.requiredColumns !== undefined ? { requiredColumns: data.requiredColumns } : {}),
    ...(data.manualIngestionEnabled !== undefined
      ? { manualIngestionEnabled: data.manualIngestionEnabled }
      : {}),
  };

  if (Object.keys(allowedData).length === 0) return existing;
  const updateExpression = buildConfigUpdateExpression(allowedData, existing);
  if (!updateExpression.UpdateExpression || updateExpression.UpdateExpression === 'SET ') return existing;

  const updated = {
    ...existing,
    ...allowedData,
    updatedAt: new Date(),
  };

  if (!isAwsConfigured()) {
    const index = mockPipelineConfigs.findIndex((config) => config.id === id);
    if (index >= 0) mockPipelineConfigs[index] = updated;
    return updated;
  }

  const response = await createDynamoDBClient().send(
    new UpdateItemCommand({
      TableName: configTableName(),
      Key: { origin_path: s(configOriginPath(existing)) },
      ReturnValues: 'ALL_NEW',
      ...updateExpression,
    })
  );

  return response.Attributes
    ? mapConfigItem(response.Attributes as Record<string, AttributeValue>)
    : updated;
}

// Cria uma linha de historico. Todas as origens usam esta funcao:
// - file: upload manual e crawler.
// - api: reprocessamento pela Step Function master.
// - calendar: entrega do XLSX para a Lambda scheduler via S3.
export async function createExecutionHistory(
  input: Partial<ExecutionHistoryRecord> &
    Pick<ExecutionHistoryRecord, 'tableName' | 'fileName' | 'status'>
) {
  const now = new Date();
  const execution: ExecutionHistoryRecord = {
    id: input.id || randomUUID(),
    tableName: input.tableName,
    fileName: input.fileName,
    fileSize: input.fileSize ?? null,
    status: input.status,
    sourceType: input.sourceType || 'file',
    startTime: input.startTime || now,
    endTime: input.endTime ?? null,
    executionArn: input.executionArn ?? null,
    duration: input.duration ?? null,
    errors: input.errors ?? null,
    userId: input.userId ?? null,
    userEmail: input.userEmail ?? null,
    userName: input.userName ?? null,
    createdAt: now,
    updatedAt: now,
  };

  if (!isAwsConfigured()) {
    mockExecutions.push(execution);
    return execution;
  }

  await createDynamoDBClient().send(
    new PutItemCommand({
      TableName: executionTableName(),
      Item: toExecutionItem(execution),
    })
  );

  return execution;
}

// Recupera um item de historico por id para telas de detalhe/refresh.
export async function getExecutionHistory(id: string) {
  if (!isAwsConfigured()) {
    return mockExecutions.find((execution) => execution.id === id) || null;
  }

  const response = await createDynamoDBClient().send(
    new GetItemCommand({
      TableName: executionTableName(),
      Key: { id: s(id) },
    })
  );

  return response.Item ? mapExecutionItem(response.Item as Record<string, AttributeValue>) : null;
}

// Atualiza status/duracao/erros de execucoes em andamento.
export async function updateExecutionHistory(id: string, data: Partial<ExecutionHistoryRecord>) {
  const existing = await getExecutionHistory(id);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...data,
    updatedAt: new Date(),
  };

  if (!isAwsConfigured()) {
    const index = mockExecutions.findIndex((execution) => execution.id === id);
    if (index >= 0) mockExecutions[index] = updated;
    return updated;
  }

  await createDynamoDBClient().send(
    new PutItemCommand({
      TableName: executionTableName(),
      Item: toExecutionItem(updated),
    })
  );

  return updated;
}

// Consulta historico com filtros simples. Como a tabela de historico nao tem
// indices especificos aqui, a leitura usa Scan; para volume alto, o proximo
// passo seria criar GSI por status/table_name/start_time.
export async function listExecutionHistories(params: {
  status?: string | null;
  tableName?: string | null;
  sourceType?: string | null;
  executionDate?: string | null;
  user?: string | null;
  limit?: number;
  since?: Date;
  runningOnly?: boolean;
  withDurationOnly?: boolean;
} = {}) {
  const source = !isAwsConfigured()
    ? mockExecutions
    : (await scanAll(executionTableName())).map(mapExecutionItem);

  return source
    .filter((execution) => !params.status || params.status === 'all' || execution.status === params.status)
    .filter((execution) => !params.tableName || params.tableName === 'all' || execution.tableName === params.tableName)
    .filter((execution) => !params.sourceType || params.sourceType === 'all' || execution.sourceType === params.sourceType)
    .filter((execution) => {
      if (!params.executionDate) return true;
      return execution.startTime.toISOString().slice(0, 10) === params.executionDate;
    })
    .filter((execution) => {
      const userSearch = params.user?.trim().toLowerCase();
      if (!userSearch) return true;
      return [execution.userName, execution.userEmail, execution.userId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(userSearch));
    })
    .filter((execution) => !params.since || execution.startTime >= params.since)
    .filter((execution) => !params.runningOnly || ['RUNNING', 'UPLOADING', 'CONVERTING', 'CRAWLING', 'VALIDATING'].includes(execution.status))
    .filter((execution) => !params.withDurationOnly || execution.duration !== null)
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    .slice(0, params.limit || source.length);
}
