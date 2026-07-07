import { S3Client } from '@aws-sdk/client-s3';
import { SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GlueClient } from '@aws-sdk/client-glue';

// Ponto unico de configuracao AWS.
// Em desenvolvimento, AWS_MOCK_MODE=true desliga chamadas reais e permite
// testar telas/fluxos sem credenciais. Em EC2, a preferencia e usar IAM Role;
// chaves no .env so sao usadas quando existirem explicitamente.
export function isAwsConfigured(): boolean {
  const hasRegion = !!process.env.AWS_REGION;
  return process.env.AWS_MOCK_MODE !== 'true' && hasRegion;
}

export function getAwsConfig() {
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
  };
}

export function createS3Client(): S3Client {
  return new S3Client(getAwsConfig());
}

export function createSFNClient(): SFNClient {
  return new SFNClient(getAwsConfig());
}

export function createDynamoDBClient(): DynamoDBClient {
  return new DynamoDBClient(getAwsConfig());
}

export function createGlueClient(): GlueClient {
  return new GlueClient(getAwsConfig());
}

export function getBucketConfig() {
  return {
    xlsxBucket: process.env.AWS_S3_BUCKET_XLSX || '',
    xlsxPrefix: process.env.AWS_S3_XLSX_PREFIX || '',
    region: process.env.AWS_REGION || '',
  };
}

export function getProcessExportConfig() {
  const rawBucket = process.env.AWS_S3_EXTRACTION_BUCKET || '';
  const explicitPrefix = process.env.AWS_S3_EXTRACTION_PREFIX || '';
  const [bucketFromPath, ...prefixParts] = rawBucket.replace(/^s3:\/\//, '').split('/');
  const prefixFromBucket = prefixParts.join('/');

  return {
    bucket: bucketFromPath || '',
    prefix: explicitPrefix || prefixFromBucket,
    tableName: process.env.EXTRACTION_TABLE_NAME || 'lucro_bruto',
  };
}

// ARN da Step Function master de ingestao API.
// O servico ingestion-service usa este valor para iniciar e monitorar
// reprocessamentos.
export function getStepFunctionConfig() {
  return {
    ingestionArn: process.env.AWS_STEP_FUNCTION_INGESTION_MASTER_ARN || '',
    transformationArn: process.env.AWS_STEP_FUNCTION_TRANSFORMATION_ONLY_ARN || '',
  };
}

// Tabelas DynamoDB usadas pela aplicacao:
// - configTable: cadastro de tabelas manuais/transient ingestion.
// - ingestionRawTable: catalogo de APIs lido pelo BLOCO 1.
// - ingestionRawIgnoreTable: lista de APIs descontinuadas/ignoradas.
// - executionHistoryTable: historico exibido em historico/monitoramento.
export function getDynamoDBConfig() {
  return {
    configTable: process.env.AWS_DYNAMODB_CONFIG_TABLE || '',
    ingestionRawTable: process.env.AWS_DYNAMODB_INGESTION_RAW_TABLE || '',
    ingestionRawIgnoreTable: process.env.AWS_DYNAMODB_INGESTION_RAW_IGNORE_TABLE || '',
    executionHistoryTable: process.env.AWS_DYNAMODB_EXECUTION_HISTORY_TABLE || '',
  };
}

function readBooleanEnv(name: string, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'sim'].includes(value.trim().toLowerCase());
}

// Template usado para criar/atualizar registros de ingestao manual no DynamoDB.
// Os valores mudam entre UAT/PRD, entao devem vir do .env carregado no processo.
export function getManualIngestionConfig() {
  return {
    originPrefix: process.env.MANUAL_INGESTION_ORIGIN_PREFIX || '',
    visibleOriginPrefix: process.env.MANUAL_INGESTION_VISIBLE_ORIGIN_PATH_PREFIX || 'ingestion_cts/',
    destinationBucket: process.env.MANUAL_INGESTION_DESTINATION_BUCKET || '',
    destinationPrefix: process.env.MANUAL_INGESTION_DESTINATION_PREFIX || '',
    processingType: process.env.MANUAL_INGESTION_PROCESSING_TYPE || '',
    typeProcess: process.env.MANUAL_INGESTION_TYPE_PROCESS || '',
    loadFull: readBooleanEnv('MANUAL_INGESTION_LOAD_FULL', false),
  };
}
