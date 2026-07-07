import { 
  StartExecutionCommand,
  DescribeExecutionCommand,
  ListExecutionsCommand,
  ExecutionStatus
} from '@aws-sdk/client-sfn';
import { createSFNClient, getStepFunctionConfig, isAwsConfigured } from '../aws-config';

interface ExecutionInput {
  s3Key: string;
  tableName: string;
  fileName: string;
}

interface ExecutionDetails {
  status: string;
  startDate?: Date;
  stopDate?: Date;
  output?: string;
  error?: string;
}

// Servico generico/legado de Step Functions.
// Observacao importante: upload manual nao deve usar esta funcao no fluxo atual;
// ele apenas envia o XLSX ao S3 e aguarda Glue Crawler. A ingestao API usa o
// servico especializado ingestion-service.ts.
export async function startStepFunctionExecution(
  input: ExecutionInput
): Promise<{ success: boolean; executionArn?: string; error?: string }> {
  if (!isAwsConfigured()) {
    console.log('[MOCK] Simulating Step Function execution start');
    const mockArn = `mock:step-functions:execution:ingestion-pipeline:exec-${Date.now()}`;
    return {
      success: true,
      executionArn: mockArn,
    };
  }

  try {
    const sfnClient = createSFNClient();
    const { ingestionArn } = getStepFunctionConfig();

    const command = new StartExecutionCommand({
      stateMachineArn: ingestionArn,
      input: JSON.stringify(input),
      name: `exec-${Date.now()}`,
    });

    const response = await sfnClient.send(command);

    return {
      success: true,
      executionArn: response.executionArn,
    };
  } catch (error: any) {
    console.error('Error starting Step Function execution:', error);
    return {
      success: false,
      error: error?.message || 'Erro ao iniciar execução do Step Function',
    };
  }
}

// Consulta status bruto de uma execucao por ARN.
export async function describeExecution(
  executionArn: string
): Promise<ExecutionDetails | null> {
  if (!isAwsConfigured()) {
    console.log('[MOCK] AWS não configurada — simulando execução bem-sucedida para:', executionArn);
    return {
      status: 'SUCCEEDED',
      startDate: new Date(Date.now() - 60000),
      stopDate: new Date(),
    };
  }

  try {
    const sfnClient = createSFNClient();

    const command = new DescribeExecutionCommand({
      executionArn,
    });

    const response = await sfnClient.send(command);

    return {
      status: response.status || 'UNKNOWN',
      startDate: response.startDate,
      stopDate: response.stopDate,
      output: response.output,
      error: response.error,
    };
  } catch (error: any) {
    console.error('Error describing execution:', error);
    return null;
  }
}

// Lista execucoes recentes da state machine configurada no ambiente.
export async function listRecentExecutions(
  limit: number = 20
): Promise<any[]> {
  if (!isAwsConfigured()) {
    console.log('[MOCK] Returning mock executions list');
    return [];
  }

  try {
    const sfnClient = createSFNClient();
    const { ingestionArn } = getStepFunctionConfig();

    const command = new ListExecutionsCommand({
      stateMachineArn: ingestionArn,
      maxResults: limit,
    });

    const response = await sfnClient.send(command);
    return response.executions || [];
  } catch (error) {
    console.error('Error listing executions:', error);
    return [];
  }
}

// Traduz status AWS para os status internos exibidos no historico.
export function mapExecutionStatus(status: string): string {
  const statusMap: { [key: string]: string } = {
    'RUNNING': 'RUNNING',
    'SUCCEEDED': 'SUCCESS',
    'FAILED': 'ERROR',
    'TIMED_OUT': 'ERROR',
    'ABORTED': 'ABORTED',
  };
  return statusMap[status] || status;
}
