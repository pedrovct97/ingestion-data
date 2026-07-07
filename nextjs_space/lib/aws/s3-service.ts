import { 
  ListObjectsV2Command, 
  PutObjectCommand,
  GetObjectCommand 
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  createS3Client,
  getBucketConfig,
  getProcessExportConfig,
  isAwsConfigured,
} from '../aws-config';

const MOCK_FOLDERS = [
  'sales_data',
  'customer_data',
  'inventory_data',
  'marketing_campaigns',
];

export interface ProcessExportFile {
  bucket: string;
  key: string;
  fileName: string;
  period: string;
  lastModified?: string;
}

let processExportFilesCache:
  | { expiresAt: number; files: ProcessExportFile[]; cacheKey: string }
  | null = null;

function normalizeExportPrefix(prefix: string) {
  return (prefix || '').replace(/^\/+/, '').replace(/\/?$/, prefix ? '/' : '');
}

function parseProcessExportFileName(fileName: string, tableName: string) {
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = fileName.match(
    new RegExp(`^(?:[a-z0-9]+-)?${escapedTable}_(\\d{4}-\\d{2})_(\\d{2})(\\d{2})(\\d{4})_(\\d{2})(\\d{2})\\.x(?:lsx|slx)$`, 'i')
  );
  if (!match) return null;

  const [, period, day, month, year, hour, minute] = match;
  return {
    period,
    timestamp: new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute)
    ).getTime(),
  };
}

async function streamToByteArray(body: any): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (typeof body.transformToByteArray === 'function') {
    return body.transformToByteArray();
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  }

  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function findLatestProcessExportFilesByMonth(): Promise<ProcessExportFile[]> {
  const { bucket, prefix, tableName } = getProcessExportConfig();
  const normalizedPrefix = normalizeExportPrefix(prefix);
  const cacheKey = `${bucket}|${normalizedPrefix}|${tableName}`;
  const now = Date.now();

  if (processExportFilesCache && processExportFilesCache.cacheKey === cacheKey && processExportFilesCache.expiresAt > now) {
    return processExportFilesCache.files;
  }

  if (!isAwsConfigured()) {
    const mockFiles = ['2025-01', '2025-02'].map((period) => ({
      bucket,
      key: `${normalizedPrefix}${tableName}_${period}_01012026_1200.xlsx`,
      fileName: `${tableName}_${period}_01012026_1200.xlsx`,
      period,
      lastModified: new Date().toISOString(),
    }));
    processExportFilesCache = {
      cacheKey,
      files: mockFiles,
      expiresAt: now + 60_000,
    };
    return mockFiles;
  }

  if (!bucket) return [];

  const s3Client = createS3Client();
  let continuationToken: string | undefined;
  const latestByPeriod = new Map<string, ProcessExportFile & { sortTime: number }>();

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizedPrefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const object of response.Contents || []) {
      const key = object.Key || '';
      const fileName = key.split('/').pop() || key;
      const parsed = parseProcessExportFileName(fileName, tableName);
      if (!parsed) continue;

      const sortTime = parsed.timestamp || object.LastModified?.getTime() || 0;
      const current = latestByPeriod.get(parsed.period);
      if (!current || sortTime > current.sortTime) {
        latestByPeriod.set(parsed.period, {
          bucket,
          key,
          fileName,
          period: parsed.period,
          lastModified: object.LastModified?.toISOString(),
          sortTime,
        });
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  const files = Array.from(latestByPeriod.values())
    .sort((a, b) => a.period.localeCompare(b.period))
    .map(({ sortTime, ...file }) => file);

  processExportFilesCache = {
    cacheKey,
    files,
    expiresAt: now + 60_000,
  };

  return files;
}

export async function findLatestProcessExportFile(period: string): Promise<ProcessExportFile | null> {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return null;
  const files = await findLatestProcessExportFilesByMonth();
  return files.find((file) => file.period === period) || null;
}

export async function generateProcessExportDownloadUrl(period: string) {
  const file = await findLatestProcessExportFile(period);
  if (!file) return null;

  if (!isAwsConfigured()) {
    return {
      ...file,
      url: `https://mock-s3-url.example.com/${file.key}`,
    };
  }

  return {
    ...file,
    url: await getSignedUrl(
      createS3Client(),
      new GetObjectCommand({
        Bucket: file.bucket,
        Key: file.key,
      }),
      { expiresIn: 900 }
    ),
  };
}

export async function getProcessExportFileObject(period: string) {
  const file = await findLatestProcessExportFile(period);
  if (!file) return null;

  if (!isAwsConfigured()) {
    return {
      file,
      bytes: new TextEncoder().encode('mock export file'),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  const response = await createS3Client().send(
    new GetObjectCommand({
      Bucket: file.bucket,
      Key: file.key,
    })
  );

  return {
    file,
    bytes: await streamToByteArray(response.Body),
    contentType:
      response.ContentType ||
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

// Lista pastas do bucket de upload manual. Hoje o cadastro de tabelas vem mais
// do DynamoDB, mas esta funcao ainda atende fluxos que precisam enxergar
// estruturas existentes no S3.
export async function listS3Folders(): Promise<string[]> {
  if (!isAwsConfigured()) {
    console.log('[MOCK] Returning mock S3 folders');
    return MOCK_FOLDERS;
  }

  try {
    const s3Client = createS3Client();
    const { xlsxBucket, xlsxPrefix } = getBucketConfig();

    const command = new ListObjectsV2Command({
      Bucket: xlsxBucket,
      Prefix: xlsxPrefix,
      Delimiter: '/',
    });

    const response = await s3Client.send(command);
    const folders = response.CommonPrefixes?.map((prefix) => 
      prefix.Prefix?.replace('/', '') || ''
    ).filter(Boolean) || [];

    return folders.length > 0 ? folders : MOCK_FOLDERS;
  } catch (error) {
    console.error('Error listing S3 folders:', error);
    return MOCK_FOLDERS;
  }
}

// Upload manual de XLSX. O arquivo e enviado sem prefixo de timestamp no nome,
// porque a Lambda do cliente deriva dataset_name diretamente do nome do arquivo.
export async function uploadFileToS3(
  file: Buffer,
  fileName: string,
  tableName: string,
  contentType: string
): Promise<{ success: boolean; key?: string; error?: string }> {
  const normalizedTableName = tableName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  const periodMatch = fileName.match(/[_-](\d{4})[_-](\d{2})\.xlsx$/i);
  const finalFileName = `${normalizedTableName}${periodMatch ? `_${periodMatch[1]}_${periodMatch[2]}` : ''}.xlsx`;
  const safeFileName = finalFileName.replace(/[^\w.\-]/g, '_');

  if (!isAwsConfigured()) {
    console.log('[MOCK] Simulating S3 upload for:', fileName);
    return {
      success: true,
      key: `${normalizedTableName}/${safeFileName}`,
    };
  }

  try {
    const s3Client = createS3Client();
    const { xlsxBucket, xlsxPrefix } = getBucketConfig();
    const prefix = xlsxPrefix.replace(/^\/+/, '').replace(/\/?$/, '/');
    const key = `${prefix}${normalizedTableName}/${safeFileName}`;

    const command = new PutObjectCommand({
      Bucket: xlsxBucket,
      Key: key,
      Body: file,
      ContentType: contentType,
    });

    await s3Client.send(command);

    return { success: true, key };
  } catch (error: any) {
    console.error('Error uploading to S3:', error);
    return {
      success: false,
      error: error?.message || 'Erro ao fazer upload para S3',
    };
  }
}

// Upload do scheduler_calendar. A aplicacao apenas entrega o XLSX no S3; a
// Lambda extraction-scheduler escuta esse prefixo e
// cria/atualiza os agendamentos no EventBridge Scheduler.
export async function uploadSchedulerCalendarToS3(
  file: Buffer,
  fileName: string,
  contentType: string
): Promise<{ success: boolean; bucket?: string; key?: string; s3Uri?: string; error?: string }> {
  const bucket = process.env.AWS_S3_SCHEDULER_CALENDAR_BUCKET || '';
  const prefix = (process.env.AWS_S3_SCHEDULER_CALENDAR_PREFIX || 'scheduler_calendar/')
    .replace(/^\/+/, '')
    .replace(/\/?$/, '/');
  const safeFileName = fileName.replace(/[^\w.\-]/g, '_');
  const key = `${prefix}${Date.now()}-${safeFileName}`;

  if (!isAwsConfigured()) {
    console.log('[MOCK] Simulating scheduler calendar S3 upload for:', fileName);
    return {
      success: true,
      bucket,
      key,
      s3Uri: `s3://${bucket}/${key}`,
    };
  }

  try {
    if (!bucket) {
      return {
        success: false,
        error: 'AWS_S3_SCHEDULER_CALENDAR_BUCKET não configurado',
      };
    }

    const s3Client = createS3Client();

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file,
      ContentType: contentType,
    });

    await s3Client.send(command);

    return {
      success: true,
      bucket,
      key,
      s3Uri: `s3://${bucket}/${key}`,
    };
  } catch (error: any) {
    console.error('Error uploading scheduler calendar to S3:', error);
    return {
      success: false,
      error: error?.message || 'Erro ao enviar calendário para S3',
    };
  }
}

// Usado em detalhes/historico quando for necessario permitir download do
// arquivo original sem deixar o bucket publico.
export async function generatePresignedDownloadUrl(
  key: string,
  expiresIn: number = 3600
): Promise<string | null> {
  if (!isAwsConfigured()) {
    console.log('[MOCK] Generating mock presigned URL for:', key);
    return `https://mock-s3-url.example.com/${key}`;
  }

  try {
    const s3Client = createS3Client();
    const { xlsxBucket } = getBucketConfig();

    const command = new GetObjectCommand({
      Bucket: xlsxBucket,
      Key: key,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn });
    return url;
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    return null;
  }
}
