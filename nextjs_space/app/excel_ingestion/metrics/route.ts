import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]/auth';
import { listExecutionHistories } from '@/lib/aws/dynamodb-app-store';
import { refreshManualCrawlerExecutions } from '@/lib/aws/execution-refresh-service';

export const dynamic = 'force-dynamic';

// Resumo do dashboard /monitoramento.
// As metricas sao calculadas a partir da tabela unificada de historico, entao
// incluem uploads manuais, API e calendario quando registrados no dia.
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const todayExecutions = await refreshManualCrawlerExecutions(
      await listExecutionHistories({ since: todayStart })
    );
    const operationalTodayExecutions = todayExecutions.filter((exec) => exec.sourceType !== 'admin');
    const totalToday = operationalTodayExecutions.length;
    const successToday = operationalTodayExecutions.filter((exec) => exec.status === 'SUCCESS').length;
    const errorToday = operationalTodayExecutions.filter((exec) =>
      ['ERROR', 'ABORTED'].includes(exec.status)
    ).length;
    const runningExecutions = await refreshManualCrawlerExecutions(
      await listExecutionHistories({ runningOnly: true })
    );
    const runningCount = runningExecutions.filter((exec) =>
      ['RUNNING', 'UPLOADING', 'CONVERTING', 'CRAWLING', 'VALIDATING'].includes(exec.status)
    ).length;
    const completedExecutions = operationalTodayExecutions.filter((exec) => exec.duration !== null);

    const avgDuration = completedExecutions.length > 0
      ? Math.floor(
          completedExecutions.reduce((sum: number, exec: any) => sum + (exec.duration || 0), 0) /
            completedExecutions.length
        )
      : 0;

    const successRate = totalToday > 0
      ? Math.floor((successToday / totalToday) * 100)
      : 0;

    const recentExecutions = await refreshManualCrawlerExecutions(
      await listExecutionHistories({ limit: 10 })
    );

    const recentExecutionsWithUsers = recentExecutions.map((execution) => ({
      ...execution,
      user: execution.userId
        ? { id: execution.userId, name: execution.userName, email: execution.userEmail }
        : null,
    }));

    return NextResponse.json({
      metrics: {
        totalToday,
        successToday,
        errorToday,
        runningCount,
        avgDuration,
        successRate,
      },
      recentExecutions: recentExecutionsWithUsers,
    });
  } catch (error: any) {
    console.error('Error fetching metrics:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar métricas' },
      { status: 500 }
    );
  }
}
