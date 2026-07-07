import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]/auth';
import {
  getTableExecutionStatuses,
  startIngestion,
  startTransformation,
  listIngestionExecutions,
} from '@/lib/aws/ingestion-service';
import { canRunApiActions, hasRouteAccess } from '@/lib/auth/roles';
import {
  createExecutionHistory,
  listExecutionHistories,
} from '@/lib/aws/dynamodb-app-store';

export const dynamic = 'force-dynamic';

// GET do semaforo de API.
// Para evitar misturar execucoes antigas do mesmo periodo, busca no historico o
// executionArn salvo quando a aplicacao iniciou o reprocessamento e monitora
// apenas esse ARN.
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!hasRouteAccess('/api-ingestao', (session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json({ error: 'Sua role não pode acessar ingestão API' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const datasetName = searchParams.get('dataset_name') || undefined;
    const period = searchParams.get('period') || undefined;
    const includeLogs = searchParams.get('logs') === 'true';

    const apiHistory =
      datasetName && period
        ? await listExecutionHistories({
            tableName: `api:${datasetName}`,
            limit: 100,
          })
        : [];

    const pinnedIngestionExecutionArn = apiHistory
      .filter((execution) => execution.sourceType === 'api')
      .filter((execution) => execution.fileName === `reprocess_${period}`)
      .map((execution) => execution.executionArn)
      .find(Boolean) as string | undefined;

    const pinnedTransformationExecutionArn = apiHistory
      .filter((execution) => execution.sourceType === 'api')
      .filter((execution) => execution.fileName === `transformation_${period}`)
      .map((execution) => execution.executionArn)
      .find(Boolean) as string | undefined;

    const status = await getTableExecutionStatuses(datasetName, period, {
      pinnedExecutionArns: pinnedIngestionExecutionArn
        ? [pinnedIngestionExecutionArn]
        : [],
      pinnedTransformationExecutionArns: pinnedTransformationExecutionArn
        ? [pinnedTransformationExecutionArn]
        : [],
    });

    let logs: unknown[] = [];
    if (includeLogs) {
      logs = await listIngestionExecutions(30);
    }

    return NextResponse.json({
      environment: process.env.APP_ENVIRONMENT || 'configured',
      stateMachine: process.env.AWS_STEP_FUNCTION_INGESTION_MASTER_ARN || '',
      dynamoTable: process.env.AWS_DYNAMODB_INGESTION_RAW_TABLE || '',
      dynamoIgnoreTable: process.env.AWS_DYNAMODB_INGESTION_RAW_IGNORE_TABLE || '',
      filters: { dataset_name: datasetName || null, period: period || null },
      ...status,
      logs: includeLogs ? logs : undefined,
    });
  } catch (error: any) {
    console.error('API ingestion GET error:', error);
    return NextResponse.json({ error: 'Erro ao buscar status da ingestão API' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!hasRouteAccess('/api-ingestao', (session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json({ error: 'Sua role não pode disparar ingestão API' }, { status: 403 });
    }

    if (!canRunApiActions((session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json(
        { error: 'Sua role não pode reprocessar ou executar transformações pela aba API' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const dataset_name = String(body.dataset_name || 'SAP').trim();
    const period = String(body.period || '').trim();
    const mode = String(body.mode || 'ingestion').trim();

    if (mode === 'transformation') {
      const result = await startTransformation({ dataset_name, period });

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      await createExecutionHistory({
        tableName: `api:${dataset_name}`,
        fileName: `transformation_${period}`,
        status: 'RUNNING',
        sourceType: 'api',
        executionArn: result.executionArn || null,
        userId: (session.user as any)?.id,
        userEmail: session.user?.email,
        userName: session.user?.name,
      });

      return NextResponse.json({
        success: true,
        executionArn: result.executionArn,
        message: `Transformações iniciadas para ${dataset_name} / ${period}`,
      });
    }

    // startIngestion valida periodo, bloqueia execucao simultanea na
    // Step Function master e inicia a execucao com nome sap-YYYYMM-timestamp.
    const result = await startIngestion({ dataset_name, period });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // Salvar o executionArn aqui e essencial para o GET "fixar" a execucao
    // atual e não consumir eventos de processamentos anteriores.
    await createExecutionHistory({
      tableName: `api:${dataset_name}`,
      fileName: `reprocess_${period}`,
      status: 'RUNNING',
      sourceType: 'api',
      executionArn: result.executionArn || null,
      userId: (session.user as any)?.id,
      userEmail: session.user?.email,
      userName: session.user?.name,
    });

    return NextResponse.json({
      success: true,
      executionArn: result.executionArn,
      message: `Reprocessamento iniciado para ${dataset_name} / ${period}`,
    });
  } catch (error: any) {
    console.error('API ingestion POST error:', error);
    return NextResponse.json({ error: 'Erro ao disparar ingestão API' }, { status: 500 });
  }
}
