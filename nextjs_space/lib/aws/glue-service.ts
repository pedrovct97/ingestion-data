import { GetCrawlerCommand } from '@aws-sdk/client-glue';
import { createGlueClient, isAwsConfigured } from '../aws-config';

export type CrawlerExecutionStatus = 'CRAWLING' | 'SUCCESS' | 'ERROR' | null;

// A Lambda manual remove o sufixo opcional _YYYY_MM do arquivo para encontrar
// dataset_name. Mantemos a mesma regra aqui para consultar o crawler correto.
function datasetNameFromFileName(fileName: string) {
  return fileName
    .split('/')
    .pop()!
    .replace(/(_\d{4}_\d{2})?\.xlsx$/i, '')
    .toLowerCase();
}

// Crawler manual segue o padrao cts_<dataset>. O dataset e normalizado para
// evitar diferenca entre nome exibido na UI e nome tecnico no Glue.
function normalizeDatasetName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function crawlerNameFromManualUpload(input: { fileName: string; tableName?: string }) {
  const datasetName = input.tableName
    ? normalizeDatasetName(input.tableName)
    : datasetNameFromFileName(input.fileName);
  return `cts_${datasetName}`;
}

async function readCrawlerStatus(crawlerName: string, uploadedAt: Date): Promise<{
  status: CrawlerExecutionStatus;
  crawlerName: string;
  finishedAt?: Date | null;
  error?: string;
  hasStarted?: boolean;
}> {
  const response = await createGlueClient().send(
    new GetCrawlerCommand({ Name: crawlerName })
  );

  const crawler = response.Crawler;
  const lastCrawl = crawler?.LastCrawl;
  const lastCrawlStartedAt = lastCrawl?.StartTime || null;
  // O historico e criado logo apos o upload para o S3. Damos uma pequena
  // margem para diferencas de relogio/latencia, mas nao podemos aceitar crawls
  // antigos: isso faria a UI concluir um upload novo com sucesso de execucao
  // anterior.
  const uploadToleranceStart = new Date(uploadedAt.getTime() - 15 * 1000);

  if (crawler?.State === 'RUNNING') {
    return { status: 'CRAWLING', crawlerName, hasStarted: true };
  }

  if (crawler?.State === 'STOPPING') {
    return {
      status: 'ERROR',
      crawlerName,
      finishedAt: new Date(),
      error: `Crawler ${crawlerName} foi encerrado antes de concluir.`,
      hasStarted: true,
    };
  }

  if (!lastCrawlStartedAt || lastCrawlStartedAt < uploadToleranceStart) {
    return { status: 'CRAWLING', crawlerName, hasStarted: false };
  }

  if (lastCrawl?.Status === 'SUCCEEDED') {
    return {
      status: 'SUCCESS',
      crawlerName,
      finishedAt: new Date(),
      hasStarted: true,
    };
  }

  if (lastCrawl?.Status === 'FAILED' || lastCrawl?.Status === 'CANCELLED') {
    return {
      status: 'ERROR',
      crawlerName,
      finishedAt: new Date(),
      error: lastCrawl.ErrorMessage || `Crawler ${crawlerName} finalizou com status ${lastCrawl.Status}`,
      hasStarted: true,
    };
  }

  return { status: 'CRAWLING', crawlerName, hasStarted: true };
}

// Consulta o estado atual do crawler. A tolerancia evita pegar um LastCrawl
// antigo e marcar como sucesso uma execucao que acabou de subir. Para uploads
// anteriores, tambem tenta o crawler derivado do nome original do arquivo,
// porque a Lambda do cliente usa o filename para montar dataset_name.
export async function getManualUploadCrawlerStatus(params: {
  fileName: string;
  tableName?: string;
  uploadedAt: Date;
}): Promise<{
  status: CrawlerExecutionStatus;
  crawlerName: string;
  finishedAt?: Date | null;
  error?: string;
  hasStarted?: boolean;
}> {
  const crawlerNames = [
    crawlerNameFromManualUpload({
      fileName: params.fileName,
      tableName: params.tableName,
    }),
    crawlerNameFromManualUpload({ fileName: params.fileName }),
  ].filter((name, index, arr) => name && arr.indexOf(name) === index);

  if (!isAwsConfigured()) {
    return { status: 'SUCCESS', crawlerName: crawlerNames[0], finishedAt: new Date(), hasStarted: true };
  }

  let lastError: string | undefined;
  let foundCrawler = false;
  try {
    for (const crawlerName of crawlerNames) {
      try {
        const result = await readCrawlerStatus(crawlerName, params.uploadedAt);
        foundCrawler = true;
        if (result.status !== 'CRAWLING') return result;
      } catch (error: any) {
        lastError = error?.message || `Erro ao consultar crawler ${crawlerName}`;
      }
    }

    if (!foundCrawler && lastError) {
      return {
        status: 'ERROR',
        crawlerName: crawlerNames[0],
        finishedAt: new Date(),
        error: lastError,
        hasStarted: false,
      };
    }

    return { status: 'CRAWLING', crawlerName: crawlerNames[0], hasStarted: false };
  } catch (error: any) {
    return {
      status: 'ERROR',
      crawlerName: crawlerNames[0],
      finishedAt: new Date(),
      error: lastError || error?.message || `Erro ao consultar crawler ${crawlerNames[0]}`,
      hasStarted: false,
    };
  }
}
