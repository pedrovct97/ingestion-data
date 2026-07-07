import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]/auth';
import { describeExecution, mapExecutionStatus } from '@/lib/aws/step-functions-service';
import { getExecutionHistory, updateExecutionHistory } from '@/lib/aws/dynamodb-app-store';
import { refreshManualCrawlerExecution } from '@/lib/aws/execution-refresh-service';

export const dynamic = 'force-dynamic';

// Detalhe/refresh de uma execucao individual.
// Se houver executionArn, consulta Step Function legado; se nao houver ARN e o
// status for CRAWLING, consulta Glue Crawler do upload manual.
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const { id } = params;

    const execution = await getExecutionHistory(id);

    if (!execution) {
      return NextResponse.json(
        { error: 'Execução não encontrada' },
        { status: 404 }
      );
    }

    if (execution.executionArn && (execution.status === 'RUNNING' || execution.status === 'UPLOADING')) {
      const awsDetails = await describeExecution(execution.executionArn);

      if (awsDetails) {
        const mappedStatus = mapExecutionStatus(awsDetails.status);
        const duration = awsDetails.startDate && awsDetails.stopDate
          ? Math.floor((awsDetails.stopDate.getTime() - awsDetails.startDate.getTime()) / 1000)
          : null;

        if (mappedStatus !== execution.status) {
          const updated = await updateExecutionHistory(id, {
            status: mappedStatus,
            endTime: awsDetails.stopDate || null,
            duration,
            errors: awsDetails.error ? JSON.stringify({
              type: 'ExecutionError',
              message: awsDetails.error,
            }) : null,
          });
          return NextResponse.json({ execution: updated });
        }
      }
    }

    if (!execution.executionArn && execution.status === 'CRAWLING') {
      const refreshed = await refreshManualCrawlerExecution(execution);
      return NextResponse.json({ execution: refreshed });
    }

    return NextResponse.json({ execution });
  } catch (error: any) {
    console.error('Error fetching execution details:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar detalhes da execução' },
      { status: 500 }
    );
  }
}
