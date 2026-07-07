import { ScanCommand, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import {
  createDynamoDBClient,
  getDynamoDBConfig,
  getManualIngestionConfig,
  isAwsConfigured,
} from '../aws-config';

const MOCK_DYNAMO_TABLES = ['adm_vendas', 'customer_data', 'inventory_data'];
// Servico auxiliar mantido para compatibilidade com rotas antigas de tabelas.
// O store principal hoje e lib/aws/dynamodb-app-store.ts, mas este arquivo ainda
// centraliza escrita direta no DynamoDB de configuracao manual.
interface ColumnDef {
  name: string;
  type: string;
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

function normalizePrefix(value: string, fallback: string) {
  return (value || fallback).replace(/^\/+/, '').replace(/\/?$/, '/');
}

function buildOriginPath(tableName: string) {
  return `${normalizePrefix('', manualIngestionConfig().originPrefix)}${tableName}/`;
}

function buildDestinationPath(tableName: string) {
  return `${normalizePrefix('', manualIngestionConfig().destinationPrefix)}${tableName}/`;
}

function tableNameFromOriginPath(originPath: string) {
  return originPath.replace(/\/+$/, '').split('/').pop() || originPath;
}

function normalizeLookup(value?: string | null) {
  return String(value || '').trim().toLowerCase();
}

async function findExistingTableItem(tableName: string) {
  const client = createDynamoDBClient();
  const { configTable } = getDynamoDBConfig();
  const byOrigin = await client.send(
    new GetItemCommand({
      TableName: configTable,
      Key: {
        origin_path: { S: buildOriginPath(tableName) },
      },
    })
  );

  if (byOrigin.Item) return byOrigin.Item;

  const target = normalizeLookup(tableName);
  let ExclusiveStartKey: Record<string, any> | undefined;

  do {
    const scanned = await client.send(
      new ScanCommand({ TableName: configTable, ExclusiveStartKey })
    );
    const found = (scanned.Items || []).find((item) => {
      const originPath = item.origin_path?.S || '';
      return [
        item.dataset_name?.S,
        item.table_name?.S,
        item.display_name?.S,
        tableNameFromOriginPath(originPath),
      ].some((value) => normalizeLookup(value) === target);
    });
    if (found) return found;
    ExclusiveStartKey = scanned.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return undefined;
}

function columnsToSchemaMap(columns: ColumnDef[]) {
  return Object.fromEntries(
    columns
      .map((column) => [
        String(column.name || '').trim(),
        { S: String(column.type || 'string').trim() || 'string' },
      ])
      .filter(([name]) => Boolean(name))
  );
}

// Verifica se uma tabela manual ja existe no DynamoDB pelo origin_path.
export async function checkTableExistsInDynamo(tableName: string): Promise<boolean> {
  if (!isAwsConfigured()) {
    console.log('[MOCK] Checking DynamoDB for table:', tableName);
    return MOCK_DYNAMO_TABLES.includes(tableName);
  }

  try {
    const client = createDynamoDBClient();
    const { configTable } = getDynamoDBConfig();

    const item = await findExistingTableItem(tableName);
    return !!item;
  } catch (error: any) {
    console.error('Error checking DynamoDB for table:', tableName, error);
    return false;
  }
}

// Atualiza ou cria o registro da tabela no DynamoDB com data_schema e paths no
// mesmo formato esperado pela Lambda de ingestao manual.
export async function updateTableInDynamo(
  tableName: string,
  columns: ColumnDef[],
  description?: string,
  manualIngestionEnabled = true
): Promise<{ success: boolean; message: string }> {
  if (!isAwsConfigured()) {
    console.log('[MOCK] Simulando atualização no DynamoDB para:', tableName);
    return {
      success: true,
      message: `[MOCK] Schema da tabela "${tableName}" atualizado no DynamoDB com ${columns.length} colunas.`,
    };
  }

  try {
    const client = createDynamoDBClient();
    const { configTable } = getDynamoDBConfig();
    const manualConfig = manualIngestionConfig();

    const existing = await findExistingTableItem(tableName);
    if (existing && existing.app_managed?.BOOL !== true) {
      return {
        success: true,
        message: `Tabela "${tableName}" ja existe no DynamoDB do cliente; configuracao preexistente preservada sem alteracoes.`,
      };
    }

    const originPath = existing?.origin_path?.S || buildOriginPath(tableName);
    const createdAt = existing?.created_at?.S || new Date().toISOString();

    const command = new PutItemCommand({
      TableName: configTable,
      Item: {
        origin_path: { S: originPath },
        arn_name: existing?.arn_name || { S: '' },
        dataset_name: { S: tableName },
        data_schema: { M: columnsToSchemaMap(columns) },
        destination_bucket: existing?.destination_bucket || { S: manualConfig.destinationBucket },
        destination_path: existing?.destination_path || { S: buildDestinationPath(tableName) },
        load_full: existing?.load_full || { BOOL: manualConfig.loadFull },
        processing_type: existing?.processing_type || { S: manualConfig.processingType },
        topic_sns: existing?.topic_sns || { S: '' },
        type_process: existing?.type_process || { S: manualConfig.typeProcess },
        table_name: existing?.table_name || { S: tableName },
        id: existing?.id || { S: originPath },
        display_name: existing?.display_name || { S: description || tableName.replace(/_/g, ' ') },
        column_count: { N: String(columns.length) },
        description: existing?.description || { S: description || '' },
        s3_prefix: existing?.s3_prefix || { S: originPath },
        source_type: existing?.source_type || { S: 'file' },
        exists_in_dynamo: existing?.exists_in_dynamo || { BOOL: true },
        is_active: existing?.is_active || { BOOL: true },
        manual_ingestion_enabled: { BOOL: manualIngestionEnabled },
        app_managed: { BOOL: true },
        created_at: { S: createdAt },
        updated_at: { S: new Date().toISOString() },
      },
    });

    await client.send(command);

    return {
      success: true,
      message: `Schema da tabela "${tableName}" atualizado no DynamoDB com sucesso.`,
    };
  } catch (error: any) {
    console.error('Erro ao atualizar DynamoDB:', tableName, error);
    return {
      success: false,
      message: `Falha ao atualizar DynamoDB: ${error?.message || 'Erro desconhecido'}`,
    };
  }
}
