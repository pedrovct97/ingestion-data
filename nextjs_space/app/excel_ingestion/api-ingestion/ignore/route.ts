import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]/auth';
import {
  getApiTablesCatalog,
  addTableToIgnore,
  removeTableFromIgnore,
} from '@/lib/aws/ingestion-service';
import { hasRouteAccess } from '@/lib/auth/roles';
import { createExecutionHistory } from '@/lib/aws/dynamodb-app-store';

export const dynamic = 'force-dynamic';

async function createApiIgnoreAudit(input: {
  session: any;
  action: 'ignore' | 'reactivate';
  datasetName: string;
  tableId: string;
}) {
  const now = new Date();
  const isIgnore = input.action === 'ignore';

  await createExecutionHistory({
    tableName: `api:${input.tableId}`,
    fileName: `${isIgnore ? 'Ignorar API' : 'Reativar API'} - ${input.tableId}`,
    status: 'SUCCESS',
    sourceType: 'admin',
    startTime: now,
    endTime: now,
    duration: 0,
    errors: JSON.stringify({
      type: 'Auditoria',
      message: `API ${input.tableId} ${isIgnore ? 'ignorada' : 'reativada'} no processamento.`,
      details: {
        action: input.action,
        datasetName: input.datasetName,
        tableId: input.tableId,
      },
    }),
    userId: input.session?.user?.id,
    userEmail: input.session?.user?.email,
    userName: input.session?.user?.name,
  });
}

async function tryCreateApiIgnoreAudit(input: Parameters<typeof createApiIgnoreAudit>[0]) {
  try {
    await createApiIgnoreAudit(input);
  } catch (error: any) {
    console.error('API ignore audit log failed:', error);
  }
}

// Lista catalogo de APIs processaveis e ignoradas. A lista de ignoradas fica em
// DynamoDB para a aplicacao e a Step Function/Lambda compartilharem a decisao.
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!hasRouteAccess('/api-ingestao', (session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json({ error: 'Sua role não pode listar tabelas da API' }, { status: 403 });
    }

    const catalog = await getApiTablesCatalog();

    return NextResponse.json({
      success: true,
      dynamoIgnoreTable: process.env.AWS_DYNAMODB_INGESTION_RAW_IGNORE_TABLE || '',
      catalog,
    });
  } catch (error: any) {
    console.error('API ignore GET error:', error);
    return NextResponse.json({ error: 'Erro ao listar tabelas' }, { status: 500 });
  }
}

// Marca uma API como ignorada/descontinuada. Isso remove a tabela do semaforo
// ativo e ajuda a evitar reprocessamentos de endpoints que nao devem rodar.
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!hasRouteAccess('/api-ingestao', (session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json({ error: 'Sua role não pode ignorar tabelas da API' }, { status: 403 });
    }

    const body = await req.json();
    const datasetName = String(body.dataset_name || body.datasetName || 'SAP').trim();
    const tableId = String(body.table_id || body.tableId || '').trim();

    const result = await addTableToIgnore(tableId, datasetName);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await tryCreateApiIgnoreAudit({
      session,
      action: 'ignore',
      datasetName,
      tableId,
    });

    const catalog = await getApiTablesCatalog();

    return NextResponse.json({
      success: true,
      message: result.message,
      catalog,
    });
  } catch (error: any) {
    console.error('API ignore POST error:', error);
    return NextResponse.json({ error: 'Erro ao ignorar tabela' }, { status: 500 });
  }
}

// Reativa uma API previamente ignorada.
export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!hasRouteAccess('/api-ingestao', (session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json({ error: 'Sua role não pode reativar tabelas da API' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const datasetName = String(searchParams.get('dataset_name') || 'SAP').trim();
    const tableId = String(searchParams.get('table_id') || '').trim();

    const result = await removeTableFromIgnore(tableId, datasetName);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await tryCreateApiIgnoreAudit({
      session,
      action: 'reactivate',
      datasetName,
      tableId,
    });

    const catalog = await getApiTablesCatalog();

    return NextResponse.json({
      success: true,
      message: result.message,
      catalog,
    });
  } catch (error: any) {
    console.error('API ignore DELETE error:', error);
    return NextResponse.json({ error: 'Erro ao reativar tabela' }, { status: 500 });
  }
}
