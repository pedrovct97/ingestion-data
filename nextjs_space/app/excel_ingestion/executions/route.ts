import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]/auth';
import { listExecutionHistories } from '@/lib/aws/dynamodb-app-store';
import { refreshManualCrawlerExecutions } from '@/lib/aws/execution-refresh-service';

export const dynamic = 'force-dynamic';

// Historico paginado/filtrado usado pela tela /historico.
// Antes de devolver os dados, atualiza execucoes manuais em CRAWLING consultando
// o Glue Crawler, para a tela refletir o estado atual sem job separado.
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const tableName = searchParams.get('tableName');
    const sourceType = searchParams.get('sourceType');
    const executionDate = searchParams.get('executionDate');
    const user = searchParams.get('user');
    const limit = parseInt(searchParams.get('limit') || '20');

    const executions = await refreshManualCrawlerExecutions(await listExecutionHistories({
      status,
      tableName,
      sourceType,
      executionDate,
      user,
      limit,
    }));

    const executionsWithUsers = executions.map((execution) => ({
      ...execution,
      user: execution.userId
        ? { id: execution.userId, name: execution.userName, email: execution.userEmail }
        : null,
    }));

    return NextResponse.json({ executions: executionsWithUsers });
  } catch (error: any) {
    console.error('Error fetching executions:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar execuções' },
      { status: 500 }
    );
  }
}
