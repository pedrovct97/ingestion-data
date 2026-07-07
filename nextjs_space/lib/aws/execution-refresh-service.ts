import {
  ExecutionHistoryRecord,
  updateExecutionHistory,
} from './dynamodb-app-store';
import { getManualUploadCrawlerStatus } from './glue-service';
import { describeExecution, mapExecutionStatus } from './step-functions-service';

function isPendingStatus(status: string) {
  return ['RUNNING', 'UPLOADING', 'CONVERTING', 'CRAWLING', 'VALIDATING'].includes(status);
}

function manualCrawlerTimeoutSeconds() {
  const configured = Number(process.env.MANUAL_UPLOAD_CRAWLER_TIMEOUT_SECONDS || '180');
  return Number.isFinite(configured) && configured > 0 ? configured : 180;
}

function formatTimeout(timeoutSeconds: number) {
  if (timeoutSeconds < 60) return `${timeoutSeconds} segundos`;
  if (timeoutSeconds === 60) return '1 minuto';
  if (timeoutSeconds % 60 === 0) return `${timeoutSeconds / 60} minutos`;
  return `${timeoutSeconds} segundos`;
}

function buildManualCrawlerTimeoutError(timeoutSeconds: number) {
  return JSON.stringify({
    type: 'ManualUploadCrawlerTimeout',
    message: `O processamento do arquivo não iniciou em até ${formatTimeout(timeoutSeconds)}.`,
    details:
      'Revise o arquivo antes de tentar novamente: valores "-" em colunas numéricas devem ser preenchidos como 0, nomes de colunas não podem ter espaços no início/fim e o cabeçalho deve seguir exatamente o modelo da tabela.',
  });
}

// Atualiza execucoes com ARN de Step Function que ainda estao abertas no
// historico. Isso fecha casos de SUCCEEDED, FAILED, TIMED_OUT e ABORTED.
async function refreshStepFunctionExecution(
  execution: ExecutionHistoryRecord
): Promise<ExecutionHistoryRecord> {
  if (!execution.executionArn || !isPendingStatus(execution.status)) {
    return execution;
  }

  const details = await describeExecution(execution.executionArn);
  if (!details) return execution;

  const mappedStatus = mapExecutionStatus(details.status);
  if (mappedStatus === execution.status) return execution;

  const finishedAt = details.stopDate || new Date();
  const updated = await updateExecutionHistory(execution.id, {
    status: mappedStatus,
    endTime: finishedAt,
    duration: details.startDate
      ? Math.max(0, Math.floor((finishedAt.getTime() - details.startDate.getTime()) / 1000))
      : null,
    errors:
      mappedStatus === 'ABORTED'
        ? JSON.stringify({
            type: 'ExecutionAborted',
            message: 'Execução abortada manualmente na Step Function.',
          })
        : details.error
        ? JSON.stringify({
            type: 'ExecutionError',
            message: details.error,
          })
        : null,
  });

  return updated || execution;
}

// Atualiza execucoes manuais que estao em CRAWLING.
// O upload manual nao dispara Step Function; depois que a Lambda processa o
// arquivo, o Glue Crawler atualiza o catalogo. Por isso o historico consulta o
// crawler periodicamente e fecha a execucao quando ele termina.
export async function refreshManualCrawlerExecution(
  execution: ExecutionHistoryRecord
): Promise<ExecutionHistoryRecord> {
  if (execution.executionArn) {
    return refreshStepFunctionExecution(execution);
  }

  if (execution.executionArn || execution.status !== 'CRAWLING') {
    return execution;
  }

  const crawler = await getManualUploadCrawlerStatus({
    fileName: execution.fileName,
    tableName: execution.tableName,
    uploadedAt: execution.startTime,
  });

  const now = new Date();
  const elapsedSeconds = Math.floor((now.getTime() - execution.startTime.getTime()) / 1000);
  const timeoutSeconds = manualCrawlerTimeoutSeconds();
  if (
    crawler.status === 'CRAWLING' &&
    crawler.hasStarted === false &&
    elapsedSeconds >= timeoutSeconds
  ) {
    const updated = await updateExecutionHistory(execution.id, {
      status: 'ERROR',
      endTime: now,
      duration: elapsedSeconds,
      errors: buildManualCrawlerTimeoutError(timeoutSeconds),
    });

    return updated || execution;
  }

  if (!crawler.status || crawler.status === execution.status) {
    return execution;
  }

  const finishedAt = crawler.finishedAt || new Date();
  const updated = await updateExecutionHistory(execution.id, {
    status: crawler.status,
    endTime: finishedAt,
    duration: Math.max(
      0,
      Math.floor((finishedAt.getTime() - execution.startTime.getTime()) / 1000)
    ),
    errors: crawler.error
      ? JSON.stringify({
          type: 'CrawlerError',
          message: crawler.error,
          crawler: crawler.crawlerName,
        })
      : null,
  });

  return updated || execution;
}

// Aplica refresh em lote para telas de historico/monitoramento.
export async function refreshManualCrawlerExecutions(
  executions: ExecutionHistoryRecord[]
): Promise<ExecutionHistoryRecord[]> {
  return Promise.all(executions.map(refreshManualCrawlerExecution));
}
