import {
  StartExecutionCommand,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  ListExecutionsCommand,
} from '@aws-sdk/client-sfn';
import {
  ScanCommand,
  PutItemCommand,
  DeleteItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  createSFNClient,
  createDynamoDBClient,
  getStepFunctionConfig,
  getDynamoDBConfig,
  isAwsConfigured,
} from '../aws-config';

export type TrafficLightStatus =
  | 'success'
  | 'partial'
  | 'error'
  | 'aborted'
  | 'running'
  | 'idle'
  | 'ignored';

export interface RawTableConfig {
  tableId: string;
  displayName?: string;
  datasetName?: string;
  columns?: { name: string; type: string }[];
  raw?: Record<string, unknown>;
}

export interface TableExecutionStatus {
  tableId: string;
  displayName: string;
  status: TrafficLightStatus;
  statusLabel: string;
  ignored?: boolean;
  ignoredAt?: string;
  executionArn?: string;
  executionName?: string;
  startDate?: string;
  stopDate?: string;
  message?: string;
  datasetName?: string;
  period?: string;
}

export interface TransformationExecutionStatus {
  name: string;
  status: TrafficLightStatus;
  statusLabel: string;
  message?: string;
  startDate?: string;
  stopDate?: string;
}

export interface IgnoredTableEntry {
  tableId: string;
  displayName?: string;
  datasetName?: string;
  ignoredAt?: string;
  reason?: string;
}

export interface ApiTablesCatalog {
  active: RawTableConfig[];
  ignored: IgnoredTableEntry[];
}

export interface IngestionInput {
  dataset_name: string;
  period: string;
}

export interface TransformationInput {
  dataset_name: string;
  period: string;
}

export interface TableExecutionStatusOptions {
  pinnedExecutionArns?: string[];
  pinnedTransformationExecutionArns?: string[];
}

function dynamoToJs(item: Record<string, AttributeValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(item)) {
    if (val.S !== undefined) out[key] = val.S;
    else if (val.N !== undefined) out[key] = Number(val.N);
    else if (val.BOOL !== undefined) out[key] = val.BOOL;
    else if (val.NULL) out[key] = null;
    else if (val.M) {
      out[key] = dynamoToJs(val.M);
    } else if (val.L) {
      out[key] = val.L.map((v) => {
        if (v.S !== undefined) return v.S;
        if (v.M) return dynamoToJs(v.M);
        return null;
      });
    }
  }
  return out;
}

const MOCK_TABLE_IDS = [
  'adm_vendas',
  'customer_data',
  'inventory_data',
  'financeiro_sap',
  'estoque_qa',
];

const mockIgnoredTableIds = new Set<string>(['estoque_qa']);

function extractTableId(data: Record<string, unknown>): string {
  return String(
    data.table_id ?? data.tableId ?? data.table_name ?? data.pk ?? ''
  ).trim();
}

async function scanDynamoRecords(tableName: string): Promise<Record<string, unknown>[]> {
  if (!isAwsConfigured()) return [];

  const client = createDynamoDBClient();
  const records: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const response = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey as any,
      })
    );

    for (const item of response.Items || []) {
      records.push(dynamoToJs(item) as Record<string, unknown>);
    }

    lastKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return records;
}

function parseExecutionPayload(payload?: string): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractTableIdsFromPayload(payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];
  const ids: string[] = [];

  const pushId = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) ids.push(v.trim());
  };

  pushId(payload.table_id);
  pushId(payload.tableId);
  pushId(payload.table_name);
  pushId(payload.tableName);

  if (Array.isArray(payload.table_ids)) {
    payload.table_ids.forEach(pushId);
  }
  if (Array.isArray(payload.tables)) {
    payload.tables.forEach((t) => {
      if (typeof t === 'string') pushId(t);
      else if (t && typeof t === 'object') {
        const obj = t as Record<string, unknown>;
        pushId(obj.table_id ?? obj.tableId ?? obj.table_name);
      }
    });
  }

  return [...new Set(ids)];
}

function normalizeTableId(value: string) {
  return value.trim().toLowerCase();
}

function normalizeAlias(value: string) {
  return normalizeTableId(value).replace(/[^a-z0-9]/g, '');
}

function extractTableIdsFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const parsed = parseExecutionPayload(value);
    return parsed ? extractTableIdsFromUnknown(parsed) : [];
  }
  if (Array.isArray(value)) {
    return [
      ...new Set(value.flatMap((item) => extractTableIdsFromUnknown(item))),
    ];
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const ids = extractTableIdsFromPayload(obj);

    for (const nestedValue of Object.values(obj)) {
      ids.push(...extractTableIdsFromUnknown(nestedValue));
    }

    return [...new Set(ids)];
  }
  return [];
}

function parseHistoryPayload(value?: string): Record<string, unknown> | null {
  return parseExecutionPayload(value);
}

const API_INGESTION_STATES = new Set([
  'Montar Glue Config',
  'Ingest Glue',
  'Pular Tabela com Erro',
  'Find Single Parquet',
  'Verificar se ha arquivos',
  'Verificar se há arquivos',
  'Pular DORA (Sem dados)',
  'Resolver Erro Queue Dora',
  'Start Dora (sync)',
  'Pular Erro do DORA',
]);

// Estados do BLOCO 2 da Step Function master. Eles sao exibidos separados dos cards
// de API para nao misturar falhas de transformacao com falhas de extracao/DORA.
const TRANSFORMATION_STATES = new Set([
  'Processo B',
  'Processo A',
  'Processo C',
  'Processo DE',
  'Net Sales',
  'Lucro Bruto',
  'Extrair Lucro Bruto',
]);
const TRANSFORMATION_ORDER = [
  'Processo B',
  'Processo A',
  'Processo C',
  'Processo DE',
  'Net Sales',
  'Lucro Bruto',
  'Extrair Lucro Bruto',
];

function buildFallbackTransformationStatuses(
  execution: Record<string, unknown> | null | undefined
): TransformationExecutionStatus[] {
  if (!execution) return [];

  const rawStatus = String(execution.status || 'RUNNING');
  const mapped = mapSfnToTrafficLight(
    rawStatus,
    typeof execution.output === 'string'
      ? execution.output
      : JSON.stringify(execution.output || ''),
    typeof execution.error === 'string' ? execution.error : undefined
  );

  const status = mapped.status === 'idle' ? 'running' : mapped.status;
  const label =
    status === 'running'
      ? 'Em execução'
      : status === 'success'
      ? 'Concluido'
      : status === 'error'
      ? 'Erro'
      : mapped.label;
  const message =
    mapped.message ||
    `Step Function de transformacao ${rawStatus.toLowerCase()}`;
  const startDate = execution.startDate
    ? new Date(execution.startDate as Date).toISOString()
    : undefined;
  const stopDate = execution.stopDate
    ? new Date(execution.stopDate as Date).toISOString()
    : undefined;

  return TRANSFORMATION_ORDER.map((name) => ({
    name,
    status,
    statusLabel: label,
    message,
    startDate,
    stopDate,
  }));
}

function eventOutcome(eventType?: string): TrafficLightStatus | null {
  if (!eventType) return null;
  if (eventType.endsWith('Succeeded')) return 'success';
  if (
    eventType.endsWith('Failed') ||
    eventType.endsWith('TimedOut') ||
    eventType.endsWith('Aborted')
  ) {
    return 'error';
  }
  if (
    eventType.endsWith('Started') ||
    eventType.endsWith('Scheduled') ||
    eventType.endsWith('Entered')
  ) {
    return 'running';
  }
  return null;
}

function eventDetails(event: any) {
  return (
    event.taskSucceededEventDetails ||
    event.taskFailedEventDetails ||
    event.lambdaFunctionFailedEventDetails ||
    event.lambdaFunctionSucceededEventDetails ||
    event.glueStartJobRunFailedEventDetails ||
    event.glueStartJobRunSucceededEventDetails ||
    event.stateEnteredEventDetails ||
    event.stateExitedEventDetails ||
    event.mapIterationStartedEventDetails ||
    event.mapIterationSucceededEventDetails ||
    event.mapIterationFailedEventDetails ||
    {}
  );
}

function getEventMessage(event: any) {
  const details = eventDetails(event);
  return (
    details.error ||
    details.cause ||
    details.output ||
    details.input ||
    details.name ||
    undefined
  );
}

// Converte qualquer payload de erro da AWS para texto. Alguns eventos retornam
// JSON em "cause" ou "output", entao centralizar isso evita mensagens quebradas
// nos cards da tela de API.
function normalizeEventMessage(message?: unknown) {
  if (message === undefined || message === null) return '';
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function extractPeriodFromText(message?: unknown) {
  const raw = normalizeEventMessage(message);
  const match = raw.match(/"?(?:--)?period"?\s*[:=]\s*"?(\d{4}-\d{2})"?/i);
  return match?.[1] || null;
}

function simplifyErrorMessage(message?: unknown) {
  const raw = normalizeEventMessage(message);
  if (!raw) return 'Erro não detalhado pela Step Function.';

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.Error) return String(parsed.Error);
    if (parsed?.error) return String(parsed.error);
    if (parsed?.Cause) return simplifyErrorMessage(parsed.Cause);
    if (parsed?.cause) return simplifyErrorMessage(parsed.cause);
  } catch {
    // Mantem fallback textual abaixo.
  }

  return raw.length > 180 ? `${raw.slice(0, 180)}...` : raw;
}

function buildTransformationMessage(
  stateName: string,
  outcome: TrafficLightStatus,
  eventMessage?: unknown
) {
  const period = extractPeriodFromText(eventMessage);
  if (outcome === 'success') {
    return period ? `Período: ${period}` : 'Transformação concluída.';
  }
  if (outcome === 'error') {
    const error = simplifyErrorMessage(eventMessage);
    return period ? `Período: ${period}. Erro: ${error}` : `Erro: ${error}`;
  }
  return `Evento atual: ${stateName}`;
}

// Traducao de erros tecnicos conhecidos para linguagem de negocio.
// Mantemos o erro original para casos novos, mas estes dois cenarios ja foram
// validados no pipeline do cliente:
// - PK ausente: problema de schema_raw e precisa acao de manutencao.
// - Hash not found: periodo sem dados, nao necessariamente falha operacional.
function classifyKnownTableIssue(message?: unknown):
  | { status: TrafficLightStatus; label: string; message: string }
  | null {
  const raw = normalizeEventMessage(message);
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (
    normalized.includes('nenhuma pk definida no schema') ||
    normalized.includes('nenhuma pk definida')
  ) {
    return {
      status: 'error',
      label: 'PK não definida',
      message: 'PK não definida no schema da tabela. Verifique o schema_raw.',
    };
  }

  if (normalized.includes('hash not found')) {
    return {
      status: 'partial',
      label: 'Sem dados no período',
      message: 'A tabela não possui dados no período informado.',
    };
  }

  return null;
}

// Extrai somente identificadores especificos da tabela dentro do Map da Step
// Function. Nao usar dataset_name/domain aqui: eles sao comuns entre varias
// tabelas e causavam cards errados ficando RUNNING/SUCCESS sem terem iniciado.
function extractTableIdsFromStateInput(input: Record<string, unknown> | null): string[] {
  if (!input) return [];
  const table = input.table as Record<string, unknown> | undefined;
  const configContainer = input.GlueConfig as Record<string, unknown> | undefined;
  const config = configContainer?.config as Record<string, unknown> | undefined;
  const ids = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) ids.add(value.trim());
  };

  add(table?.table_id);
  add(table?.table_name);
  add(config?.table_id);
  add(config?.table_name);

  return Array.from(ids);
}

// Converte tipos de eventos do historico da Step Function para o semaforo da UI.
// Esta funcao olha o evento pontual, nao o status final da execucao master.
function stateEventOutcome(event: any): TrafficLightStatus | null {
  const type = String(event.type || '');
  if (
    type === 'TaskFailed' ||
    type === 'TaskTimedOut' ||
    type === 'LambdaFunctionFailed' ||
    type === 'LambdaFunctionTimedOut'
  ) {
    return 'error';
  }
  if (
    type === 'TaskSucceeded' ||
    type === 'LambdaFunctionSucceeded' ||
    type === 'PassStateExited' ||
    type === 'SucceedStateExited'
  ) {
    return 'success';
  }
  if (
    type === 'TaskStateEntered' ||
    type === 'TaskScheduled' ||
    type === 'TaskStarted' ||
    type === 'PassStateEntered'
  ) {
    return 'running';
  }
  return null;
}

function mapSfnToTrafficLight(
  sfnStatus: string,
  output?: string,
  error?: string
): { status: TrafficLightStatus; label: string; message?: string } {
  if (sfnStatus === 'RUNNING') {
    return { status: 'running', label: 'Em execução' };
  }

  if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(sfnStatus)) {
    if (sfnStatus === 'ABORTED') {
      return {
        status: 'aborted',
        label: 'Abortada',
        message: 'Execução abortada manualmente na Step Function.',
      };
    }

    return {
      status: 'error',
      label: 'Erro',
      message: error || 'Execução falhou',
    };
  }

  if (sfnStatus === 'SUCCEEDED') {
    const out = parseExecutionPayload(output);
    const outStr = JSON.stringify(out || output || '').toLowerCase();
    const hasPartial =
      outStr.includes('partial') ||
      outStr.includes('warning') ||
      outStr.includes('skipped') ||
      (out &&
        typeof out === 'object' &&
        (out.partial === true || out.status === 'PARTIAL' || out.success === false));

    if (hasPartial) {
      return {
        status: 'partial',
        label: 'Concluído parcialmente',
        message: 'Execução terminou com avisos ou falhas parciais',
      };
    }
    return { status: 'success', label: 'Concluído' };
  }

  return { status: 'idle', label: 'Sem execução recente' };
}

function rawConfigFromRecord(data: Record<string, unknown>): RawTableConfig | null {
  const tableId = extractTableId(data);
  if (!tableId) return null;

  let columns: { name: string; type: string }[] | undefined;
  if (typeof data.columns === 'string') {
    try {
      columns = JSON.parse(data.columns);
    } catch {
      columns = undefined;
    }
  } else if (Array.isArray(data.columns)) {
    columns = data.columns as { name: string; type: string }[];
  }

  return {
    tableId,
    displayName: String(data.display_name ?? data.displayName ?? tableId),
    datasetName: String(data.dataset_name ?? data.datasetName ?? ''),
    columns,
    raw: data,
  };
}

export async function listIgnoredTableIds(): Promise<IgnoredTableEntry[]> {
  if (!isAwsConfigured()) {
    return Array.from(mockIgnoredTableIds).map((tableId) => ({
      tableId,
      displayName: tableId.replace(/_/g, ' '),
      ignoredAt: new Date().toISOString(),
      reason: 'mock',
    }));
  }

  try {
    const { ingestionRawIgnoreTable } = getDynamoDBConfig();
    const records = await scanDynamoRecords(ingestionRawIgnoreTable);
    const entries: IgnoredTableEntry[] = [];

    for (const data of records) {
      const tableId = extractTableId(data);
      if (!tableId) continue;
      entries.push({
        tableId,
        displayName: String(data.display_name ?? data.displayName ?? tableId),
        datasetName: String(data.dataset_name ?? data.datasetName ?? ''),
        ignoredAt: String(data.ignored_at ?? data.updated_at ?? ''),
        reason: String(data.reason ?? data.status ?? ''),
      });
    }

    return entries.sort((a, b) => a.tableId.localeCompare(b.tableId));
  } catch (error) {
    console.error('Error scanning ignore DynamoDB:', error);
    return [];
  }
}

export async function getApiTablesCatalog(): Promise<ApiTablesCatalog> {
  const rawTables = await listRawTableConfigs();
  const ignoredEntries = await listIgnoredTableIds();
  const ignoredIds = new Set(ignoredEntries.map((e) => e.tableId));

  const active = rawTables.filter((t) => !ignoredIds.has(t.tableId));

  const ignored: IgnoredTableEntry[] = ignoredEntries.map((entry) => {
    const raw = rawTables.find((t) => t.tableId === entry.tableId);
    return {
      ...entry,
      displayName: entry.displayName || raw?.displayName || entry.tableId,
    };
  });

  return { active, ignored };
}

export async function addTableToIgnore(
  tableId: string,
  datasetName = 'SAP'
): Promise<{ success: boolean; message?: string; error?: string }> {
  const id = tableId.trim();
  if (!id) return { success: false, error: 'table_id é obrigatório' };
  const dataset = datasetName.trim() || 'SAP';

  if (!isAwsConfigured()) {
    mockIgnoredTableIds.add(id);
    return {
      success: true,
      message: `[MOCK] Tabela "${id}" adicionada à lista de ignoradas.`,
    };
  }

  try {
    const client = createDynamoDBClient();
    const { ingestionRawIgnoreTable } = getDynamoDBConfig();
    const now = new Date().toISOString();

    await client.send(
      new PutItemCommand({
        TableName: ingestionRawIgnoreTable,
        Item: {
          dataset_name: { S: dataset },
          table_id: { S: id },
          table_name: { S: id },
          display_name: { S: id },
          ignored_at: { S: now },
          updated_at: { S: now },
          reason: { S: 'discontinued' },
        },
      })
    );

    return {
      success: true,
      message: `Tabela "${id}" será ignorada pelo processamento API.`,
    };
  } catch (error: any) {
    console.error('Error adding table to ignore:', error);
    return {
      success: false,
      error: error?.message || 'Erro ao registrar tabela ignorada',
    };
  }
}

export async function removeTableFromIgnore(
  tableId: string,
  datasetName = 'SAP'
): Promise<{ success: boolean; message?: string; error?: string }> {
  const id = tableId.trim();
  if (!id) return { success: false, error: 'table_id é obrigatório' };
  const dataset = datasetName.trim() || 'SAP';

  if (!isAwsConfigured()) {
    mockIgnoredTableIds.delete(id);
    return {
      success: true,
      message: `[MOCK] Tabela "${id}" removida da lista de ignoradas.`,
    };
  }

  try {
    const client = createDynamoDBClient();
    const { ingestionRawIgnoreTable } = getDynamoDBConfig();

    await client.send(
      new DeleteItemCommand({
        TableName: ingestionRawIgnoreTable,
        Key: {
          dataset_name: { S: dataset },
          table_id: { S: id },
        },
      })
    );

    return {
      success: true,
      message: `Tabela "${id}" voltou a ser processada na fila API.`,
    };
  } catch (error: any) {
    console.error('Error removing table from ignore:', error);
    return {
      success: false,
      error: error?.message || 'Erro ao remover tabela da lista de ignoradas',
    };
  }
}

export async function listRawTableConfigs(): Promise<RawTableConfig[]> {
  if (!isAwsConfigured()) {
    return MOCK_TABLE_IDS.map((tableId) => ({
      tableId,
      displayName: tableId.replace(/_/g, ' '),
      datasetName: 'SAP',
    }));
  }

  try {
    const { ingestionRawTable } = getDynamoDBConfig();
    const records = await scanDynamoRecords(ingestionRawTable);
    const unique = new Map<string, RawTableConfig>();

    for (const data of records) {
      const config = rawConfigFromRecord(data);
      if (config) unique.set(config.tableId, config);
    }

    return Array.from(unique.values()).sort((a, b) =>
      a.tableId.localeCompare(b.tableId)
    );
  } catch (error) {
    console.error('Error scanning ingestion raw DynamoDB:', error);
    return MOCK_TABLE_IDS.map((tableId) => ({
      tableId,
      displayName: tableId.replace(/_/g, ' '),
      datasetName: 'SAP',
    }));
  }
}

async function describeIngestionExecution(executionArn: string) {
  const sfnClient = createSFNClient();
  const detail = await sfnClient.send(
    new DescribeExecutionCommand({ executionArn })
  );
  const progress = await analyzeExecutionHistory(executionArn);
  const input = parseExecutionPayload(detail.input);
  const output = parseExecutionPayload(detail.output);
  const tableIds = [
    ...new Set([
      ...extractTableIdsFromPayload(input),
      ...extractTableIdsFromPayload(output),
    ]),
  ];

  return {
    executionArn: detail.executionArn,
    name: detail.name,
    status: detail.status || 'UNKNOWN',
    startDate: detail.startDate,
    stopDate: detail.stopDate,
    tableIds,
    tableEvents: progress.tableEvents,
    transformationEvents: progress.transformationEvents,
    input,
    output,
    error: detail.error,
  };
}

async function describeIngestionExecutionsSafely(executionArns: string[]) {
  const results = await Promise.allSettled(
    executionArns.map((executionArn) => describeIngestionExecution(executionArn))
  );

  return results
    .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof describeIngestionExecution>>> => {
      if (result.status === 'fulfilled') return true;
      console.warn('Ignoring transient Step Function describe failure:', result.reason?.code || result.reason?.message || result.reason);
      return false;
    })
    .map((result) => result.value);
}

// Le todos os eventos de uma execucao especifica e transforma o historico bruto
// da Step Function em dois conjuntos compreensiveis pela tela:
// 1. tableEvents: eventos do BLOCO 1 vinculados a uma tabela do Map.
// 2. transformationEvents: eventos sequenciais do BLOCO 2 de Glue transforms.
//
// A navegacao por previousEventId e importante porque eventos como TaskSucceeded
// nao trazem o input completo diretamente; o input com table_id/table_name fica
// no evento StateEntered relacionado.
async function analyzeExecutionHistory(
  executionArn: string
): Promise<{
  tableEvents: Array<{
    stateName: string;
    status: TrafficLightStatus;
    tableIds: string[];
    eventTime?: Date;
    message?: string;
  }>;
  transformationEvents: TransformationExecutionStatus[];
}> {
  const sfnClient = createSFNClient();
  const events: any[] = [];
  let nextToken: string | undefined;

  do {
    const response = await sfnClient.send(
      new GetExecutionHistoryCommand({
        executionArn,
        maxResults: 1000,
        nextToken,
        reverseOrder: false,
      })
    );
    events.push(...(response.events || []));
    nextToken = response.nextToken;
  } while (nextToken);

  const byId = new Map<number, any>();
  for (const event of events) {
    if (typeof event.id === 'number') byId.set(event.id, event);
  }

  const getStateContext = (event: any) => {
    const visited = new Set<number>();
    let current = event;

    while (current) {
      const stateEntered = current.stateEnteredEventDetails;
      if (stateEntered?.name) {
        const input = parseHistoryPayload(stateEntered.input);
        return {
          stateName: String(stateEntered.name),
          tableIds: extractTableIdsFromStateInput(input),
        };
      }

      if (!current.previousEventId || visited.has(current.previousEventId)) break;
      visited.add(current.previousEventId);
      current = byId.get(current.previousEventId);
      if (!current) break;
    }

    return {
      stateName: '',
      tableIds: [],
    };
  };

  const tableEvents: Array<{
    stateName: string;
    status: TrafficLightStatus;
    tableIds: string[];
    eventTime?: Date;
    message?: string;
  }> = [];
  const transformations = new Map<string, TransformationExecutionStatus>();
  for (const event of events) {
    const outcome = stateEventOutcome(event);
    if (!outcome) continue;

    const context = getStateContext(event);
    const stateName = context.stateName || event.stateEnteredEventDetails?.name || '';
    if (!stateName) continue;

    if (API_INGESTION_STATES.has(stateName) && context.tableIds.length > 0) {
      tableEvents.push({
        stateName,
        status:
          stateName === 'Pular DORA (Sem dados)' && outcome === 'success'
            ? 'partial'
            : outcome,
        tableIds: context.tableIds,
        eventTime: event.timestamp,
        message: getEventMessage(event),
      });
    }

    if (TRANSFORMATION_STATES.has(stateName)) {
      const previous = transformations.get(stateName);
      const eventMessage = getEventMessage(event);
      const next: TransformationExecutionStatus = {
        name: stateName,
        status: outcome,
        statusLabel:
          outcome === 'success'
            ? 'Concluido'
            : outcome === 'error'
              ? 'Erro'
              : 'Em execução',
        message: buildTransformationMessage(stateName, outcome, eventMessage),
        startDate: previous?.startDate || event.timestamp?.toISOString?.(),
        stopDate:
          outcome === 'success' || outcome === 'error'
            ? event.timestamp?.toISOString?.()
            : previous?.stopDate,
      };

      const previousTime =
        previous?.stopDate || previous?.startDate
          ? new Date(previous.stopDate || previous.startDate || '').getTime()
          : 0;
      const nextTime = event.timestamp?.getTime?.() || 0;
      if (!previous || nextTime >= previousTime) {
        transformations.set(stateName, next);
      }
    }
  }

  return {
    tableEvents,
    transformationEvents:
      transformations.size > 0
        ? TRANSFORMATION_ORDER.map((name) =>
            transformations.get(name) || {
              name,
              status: 'idle',
              statusLabel: 'Aguardando',
            }
          )
        : [],
  };
}

export async function listIngestionExecutions(
  limit = 50,
  pinnedExecutionArns: string[] = [],
  stateMachineArnOverride?: string
) {
  if (!isAwsConfigured()) {
    const now = Date.now();
    return MOCK_TABLE_IDS.map((tableId, i) => ({
      executionArn: `mock:step-functions:execution:api-ingestion:mock-${tableId}-${i}`,
      name: `mock-${tableId}`,
      status: i % 3 === 0 ? 'FAILED' : i % 3 === 1 ? 'RUNNING' : 'SUCCEEDED',
      startDate: new Date(now - 3600000),
      stopDate: i % 3 === 1 ? undefined : new Date(now - 1800000),
      tableIds: [tableId],
      doraSucceededTableIds: i % 3 === 2 ? [tableId] : [],
      input: { dataset_name: 'SAP', period: '2025-05', table_id: tableId },
      output:
        i % 3 === 2
          ? { status: 'PARTIAL', message: 'Alguns registros ignorados' }
          : { status: 'OK' },
      error: i % 3 === 0 ? 'Timeout na extração SAP' : undefined,
    }));
  }

  try {
    const sfnClient = createSFNClient();
    const { ingestionArn } = getStepFunctionConfig();
    const stateMachineArn = stateMachineArnOverride || ingestionArn;
    const pinnedArns = [...new Set(pinnedExecutionArns.filter(Boolean))];

    // Quando a aplicacao iniciou um reprocessamento, ela salva o executionArn no
    // DynamoDB. Se esse ARN existe, monitoramos somente essa execucao para nao
    // misturar eventos antigos do mesmo dataset/periodo no semaforo atual.
    if (pinnedArns.length > 0) {
      const pinnedExecutions = await describeIngestionExecutionsSafely(pinnedArns);

      return pinnedExecutions.sort(
        (a, b) => (b.startDate?.getTime() || 0) - (a.startDate?.getTime() || 0)
      );
    }

    const response = await sfnClient.send(
      new ListExecutionsCommand({
        stateMachineArn,
        maxResults: Math.min(limit, 100),
      })
    );

    const enriched = await describeIngestionExecutionsSafely(
      (response.executions || [])
        .map((exec) => exec.executionArn)
        .filter(Boolean) as string[]
    );

    return enriched.sort(
      (a, b) =>
        (b.startDate?.getTime() || 0) - (a.startDate?.getTime() || 0)
    );
  } catch (error) {
    console.error('Error listing ingestion executions:', error);
    return [];
  }
}

function buildIgnoredStatus(entry: IgnoredTableEntry): TableExecutionStatus {
  return {
    tableId: entry.tableId,
    displayName: entry.displayName || entry.tableId,
    status: 'ignored',
    statusLabel: 'Ignorada no processamento',
    ignored: true,
    ignoredAt: entry.ignoredAt,
    message: 'API descontinuada — Step Function pula esta tabela na fila',
  };
}

export async function getTableExecutionStatuses(
  datasetName?: string,
  period?: string,
  optionsOrPinnedExecutionArns: string[] | TableExecutionStatusOptions = []
): Promise<{
  tables: TableExecutionStatus[];
  ignoredTables: TableExecutionStatus[];
  transformationStatuses: TransformationExecutionStatus[];
  catalog: ApiTablesCatalog;
  lastMasterExecution?: {
    executionArn?: string;
    status: string;
    startDate?: string;
    datasetName?: string;
    period?: string;
  };
}> {
  const catalog = await getApiTablesCatalog();
  const options = Array.isArray(optionsOrPinnedExecutionArns)
    ? { pinnedExecutionArns: optionsOrPinnedExecutionArns }
    : optionsOrPinnedExecutionArns;
  const pinnedExecutionArns = options.pinnedExecutionArns || [];
  const pinnedTransformationExecutionArns =
    options.pinnedTransformationExecutionArns || [];
  const executions = await listIngestionExecutions(
    pinnedExecutionArns.length > 0 ? pinnedExecutionArns.length : 12,
    pinnedExecutionArns
  );

  const filteredExecutions = executions.filter((exec) => {
    if (!datasetName && !period) return true;
    const input = exec.input as Record<string, unknown> | undefined;
    const executionDataset = input?.dataset_name ?? input?.dataset;
    if (datasetName && executionDataset !== datasetName) return false;
    if (period && input?.period !== period) return false;
    return true;
  });

  const periodKey = period?.replace('-', '');
  const appMasterExecutions =
    periodKey && pinnedExecutionArns.length === 0
      ? filteredExecutions.filter((exec) =>
          String(exec.name || '').startsWith(`sap-${periodKey}-`)
        )
      : filteredExecutions;
  const masterExec = appMasterExecutions[0] || filteredExecutions[0];
  const statusExecutions = masterExec ? [masterExec] : filteredExecutions;

  const activeTables = catalog.active;
  const tableIds =
    activeTables.length > 0
      ? activeTables.map((t) => t.tableId)
      : [
          ...new Set(
            filteredExecutions.flatMap((e) => e.tableIds as string[])
          ),
        ].filter((id) => !catalog.ignored.some((ig) => ig.tableId === id));

  const tableAliases = new Map<string, string>();
  const addAlias = (tableId: string, value?: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    tableAliases.set(normalizeAlias(value), tableId);
  };

  // Mapa de aliases permitido para resolver eventos em cards. Ele e restrito
  // de proposito: dataset_name, domain e strings genericas do payload nao podem
  // entrar, pois sao compartilhados e ja causaram contaminacao entre tabelas.
  for (const table of activeTables) {
    addAlias(table.tableId, table.tableId);
    addAlias(table.tableId, table.displayName);

    const raw = table.raw || {};
    addAlias(table.tableId, raw.table_id);
    addAlias(table.tableId, raw.tableId);
    addAlias(table.tableId, raw.table_name);
    addAlias(table.tableId, raw.tableName);
  }

  const resolveTableId = (value: string) => tableAliases.get(normalizeAlias(value));

  const perTableEvents = new Map<string, Array<{
    stateName: string;
    status: TrafficLightStatus;
    eventTime?: Date;
    message?: string;
  }>>();

  // Agrupa eventos por tabela real antes de calcular o semaforo. Se um evento
  // nao possui table_id/table_name reconhecido, ele e ignorado para nao afetar
  // indevidamente outro card.
  for (const execution of statusExecutions) {
    const events = ((execution as any).tableEvents || []) as Array<{
      stateName: string;
      status: TrafficLightStatus;
      tableIds: string[];
      eventTime?: Date;
      message?: string;
    }>;

    for (const event of events) {
      for (const rawId of event.tableIds) {
        const resolvedId = resolveTableId(rawId);
        if (!resolvedId) continue;
        const list = perTableEvents.get(resolvedId) || [];
        list.push({
          stateName: event.stateName,
          status: event.status,
          eventTime: event.eventTime,
          message: event.message,
        });
        perTableEvents.set(resolvedId, list);
      }
    }
  }

  let transformationSourceExec = masterExec;
  if (pinnedTransformationExecutionArns.length > 0) {
    const transformationExecutions = await listIngestionExecutions(
      20,
      pinnedTransformationExecutionArns
    );
    transformationSourceExec = transformationExecutions[0] || transformationSourceExec;
  } else if (datasetName && periodKey) {
    const { transformationArn } = getStepFunctionConfig();
    if (transformationArn) {
      const transformationExecutions = await listIngestionExecutions(
        10,
        [],
        transformationArn
      );
      transformationSourceExec =
        transformationExecutions.find((exec) =>
          String(exec.name || '').startsWith(
            `transform-${datasetName.toLowerCase()}-${periodKey}-`
          )
        ) || transformationSourceExec;
    }
  }

  let transformationStatuses = (((transformationSourceExec as any)?.transformationEvents || []) as TransformationExecutionStatus[])
    .sort((a, b) => {
      const aTime = a.startDate ? new Date(a.startDate).getTime() : 0;
      const bTime = b.startDate ? new Date(b.startDate).getTime() : 0;
      return aTime - bTime;
    });

  const isTransformationExecution =
    Boolean(transformationSourceExec) &&
    (pinnedTransformationExecutionArns.length > 0 ||
      String((transformationSourceExec as any)?.name || '').startsWith('transform-') ||
      transformationSourceExec !== masterExec);

  if (transformationStatuses.length === 0 && isTransformationExecution) {
    transformationStatuses = buildFallbackTransformationStatuses(
      transformationSourceExec as Record<string, unknown>
    );
  }

  const tables: TableExecutionStatus[] = tableIds.map((tableId) => {
    const config = activeTables.find((t) => t.tableId === tableId);
    const tableExecs = statusExecutions.filter((e) =>
      (e.tableIds as string[]).includes(tableId)
    );
    const latest = tableExecs[0];
    const executionContext = latest || masterExec;
    const eventsForTable = (perTableEvents.get(tableId) || []).sort(
      (a, b) => (b.eventTime?.getTime() || 0) - (a.eventTime?.getTime() || 0)
    );

    const latestByState = new Map<string, {
      stateName: string;
      status: TrafficLightStatus;
      eventTime?: Date;
      message?: string;
    }>();

    for (const event of eventsForTable) {
      const current = latestByState.get(event.stateName);
      const eventTime = event.eventTime?.getTime() || 0;
      const currentTime = current?.eventTime?.getTime() || 0;
      if (!current || eventTime >= currentTime) {
        latestByState.set(event.stateName, event);
      }
    }

    const stateSnapshots = Array.from(latestByState.values()).sort(
      (a, b) => (b.eventTime?.getTime() || 0) - (a.eventTime?.getTime() || 0)
    );
    const latestTableEvent = stateSnapshots[0];
    const latestTableError = stateSnapshots.find((event) => event.status === 'error');
    const knownIssue = latestTableError ? classifyKnownTableIssue(latestTableError.message) : null;
    const doraSuccess = stateSnapshots.find(
      (event) => event.stateName === 'Start Dora (sync)' && event.status === 'success'
    );
    const noDataSkip = stateSnapshots.find(
      (event) => event.stateName === 'Pular DORA (Sem dados)' && event.status === 'partial'
    );
    const masterAborted = String(masterExec?.status || '') === 'ABORTED';

    // Regra central do semaforo: tabela sem evento proprio no BLOCO 1 continua
    // como "Sem execucao", mesmo se a Step Function master estiver RUNNING.
    // Isso reflete o MaxConcurrency=3 do Map: apenas as tabelas iniciadas devem
    // aparecer em execucao.
    if (!latestTableEvent) {
      return {
        tableId,
        displayName: config?.displayName || tableId,
        status: 'idle',
        statusLabel: 'Sem execução',
        datasetName: config?.datasetName,
      };
    }

    // Prioridade dos estados do card:
    // 1. Erro conhecido traduzido para negocio.
    // 2. Erro tecnico da etapa especifica.
    // 3. Sucesso somente quando Start Dora (sync) daquela tabela concluiu.
    // 4. Sem dados quando a propria tabela pulou DORA.
    // 5. Em execucao na ultima etapa vista para aquela tabela.
    const statusForTable = knownIssue
      ? knownIssue
      : latestTableError
      ? {
          status: 'error' as TrafficLightStatus,
          label: 'Erro',
          message: `Erro em ${latestTableError.stateName}${latestTableError.message ? `: ${normalizeEventMessage(latestTableError.message).slice(0, 180)}` : ''}`,
        }
      : doraSuccess
      ? {
          status: 'success' as TrafficLightStatus,
          label: 'Dora concluido',
          message: 'Task Start Dora (sync) finalizada com sucesso',
        }
      : noDataSkip
      ? {
          status: 'partial' as TrafficLightStatus,
          label: 'Sem dados no período',
          message: 'Bloco 1 finalizado sem acionar Dora para esta tabela',
        }
      : masterAborted && latestTableEvent?.status === 'running'
        ? {
            status: 'aborted' as TrafficLightStatus,
            label: 'Abortada',
            message: 'Execução abortada manualmente na Step Function.',
          }
      : latestTableEvent
        ? {
            status: 'running' as TrafficLightStatus,
            label: `Em ${latestTableEvent.stateName}`,
            message: latestTableEvent.message,
          }
        : {
            status: 'idle' as TrafficLightStatus,
            label: 'Sem execução',
            message: undefined,
          };

    const input = executionContext?.input as Record<string, unknown> | undefined;

    return {
      tableId,
      displayName: config?.displayName || tableId,
      status: statusForTable.status,
      statusLabel: statusForTable.label,
      executionArn: executionContext?.executionArn as string | undefined,
      executionName: executionContext?.name as string | undefined,
      startDate: (latestTableEvent?.eventTime || executionContext?.startDate)
        ? new Date((latestTableEvent?.eventTime || executionContext?.startDate) as Date).toISOString()
        : undefined,
      stopDate: executionContext?.stopDate
        ? new Date(executionContext.stopDate as Date).toISOString()
        : undefined,
      message: statusForTable.message,
      datasetName: String(input?.dataset_name ?? datasetName ?? ''),
      period: String(input?.period ?? period ?? ''),
    };
  });

  const ignoredTables = catalog.ignored.map(buildIgnoredStatus);

  const masterInput = masterExec?.input as Record<string, unknown> | undefined;

  return {
    tables,
    ignoredTables,
    transformationStatuses,
    catalog,
    lastMasterExecution: masterExec
      ? {
          executionArn: masterExec.executionArn as string | undefined,
          status: masterExec.status as string,
          startDate: masterExec.startDate
            ? new Date(masterExec.startDate as Date).toISOString()
            : undefined,
          datasetName: String(masterInput?.dataset_name ?? masterInput?.dataset ?? ''),
          period: String(masterInput?.period ?? ''),
        }
      : undefined,
  };
}

export async function startIngestion(
  input: IngestionInput
): Promise<{ success: boolean; executionArn?: string; error?: string }> {
  if (!input.dataset_name?.trim() || !input.period?.trim()) {
    return { success: false, error: 'dataset_name e period são obrigatórios' };
  }

  if (!/^\d{4}-\d{2}$/.test(input.period)) {
    return { success: false, error: 'period deve estar no formato YYYY-MM' };
  }

  if (!isAwsConfigured()) {
    const mockArn = `mock:step-functions:execution:api-ingestion:exec-${Date.now()}`;
    console.log('[MOCK] ingestion started:', input);
    return { success: true, executionArn: mockArn };
  }

  try {
    const sfnClient = createSFNClient();
    const { ingestionArn } = getStepFunctionConfig();
    const runningExecutions = await sfnClient.send(
      new ListExecutionsCommand({
        stateMachineArn: ingestionArn,
        statusFilter: 'RUNNING',
        maxResults: 1,
      })
    );

    const runningExecution = runningExecutions.executions?.[0];
    if (runningExecution) {
      return {
        success: false,
        error: `Já existe uma execução em andamento (${runningExecution.name || runningExecution.executionArn}). Aguarde a finalização antes de iniciar outro reprocessamento.`,
      };
    }

    const response = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: ingestionArn,
        input: JSON.stringify({
          dataset_name: input.dataset_name.trim(),
          period: input.period.trim(),
        }),
        name: `sap-${input.period.replace('-', '')}-${Date.now()}`,
      })
    );

    return { success: true, executionArn: response.executionArn };
  } catch (error: any) {
    console.error('Error starting ingestion:', error);
    return {
      success: false,
      error: error?.message || 'Erro ao iniciar Step Function',
    };
  }
}

export async function startTransformation(
  input: TransformationInput
): Promise<{ success: boolean; executionArn?: string; error?: string }> {
  if (!input.dataset_name?.trim() || !input.period?.trim()) {
    return { success: false, error: 'dataset_name e period são obrigatórios' };
  }

  if (!/^\d{4}-\d{2}$/.test(input.period)) {
    return { success: false, error: 'period deve estar no formato YYYY-MM' };
  }

  if (!isAwsConfigured()) {
    const mockArn = `mock:step-functions:execution:transformation:exec-${Date.now()}`;
    console.log('[MOCK] transformation started:', input);
    return { success: true, executionArn: mockArn };
  }

  try {
    const sfnClient = createSFNClient();
    const { transformationArn } = getStepFunctionConfig();

    if (!transformationArn) {
      return {
        success: false,
        error: 'AWS_STEP_FUNCTION_TRANSFORMATION_ONLY_ARN não configurada',
      };
    }

    const runningExecutions = await sfnClient.send(
      new ListExecutionsCommand({
        stateMachineArn: transformationArn,
        statusFilter: 'RUNNING',
        maxResults: 1,
      })
    );

    const runningExecution = runningExecutions.executions?.[0];
    if (runningExecution) {
      return {
        success: false,
        error: `Ja existe uma transformacao em andamento (${runningExecution.name || runningExecution.executionArn}). Aguarde finalizar antes de iniciar outra.`,
      };
    }

    const response = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: transformationArn,
        input: JSON.stringify({
          dataset_name: input.dataset_name.trim(),
          period: input.period.trim(),
        }),
        name: `transform-${input.dataset_name.trim().toLowerCase()}-${input.period.replace('-', '')}-${Date.now()}`,
      })
    );

    return { success: true, executionArn: response.executionArn };
  } catch (error: any) {
    console.error('Error starting transformation:', error);
    return {
      success: false,
      error: error?.message || 'Erro ao iniciar Step Function de transformacao',
    };
  }
}
