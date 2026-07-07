import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]/auth';
import { updateTableInDynamo } from '@/lib/aws/dynamodb-service';
import { canCreateTables } from '@/lib/auth/roles';
import {
  createExecutionHistory,
  createPipelineConfig,
  getPipelineConfigByTableName,
  updatePipelineConfig,
} from '@/lib/aws/dynamodb-app-store';
import {
  validateTableName,
  normalizeTableName,
  type InferredColumn,
} from '@/lib/xlsx-inference';

export const dynamic = 'force-dynamic';

const ATHENA_COLUMN_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date'];

function validateAthenaColumnTypes(columns: InferredColumn[]) {
  const invalidColumns = columns.filter((column) => !ATHENA_COLUMN_TYPES.includes(String(column.type || '').toLowerCase()));
  if (invalidColumns.length === 0) return null;

  const invalidList = invalidColumns
    .map((column) => `${column.name || '(sem nome)'} (${column.type || 'sem tipo'})`)
    .join(', ');

  return `Tipos inválidos para Athena: ${invalidList}. Tipos permitidos: ${ATHENA_COLUMN_TYPES.join(', ')}.`;
}

async function tryCreateExecutionHistory(input: Parameters<typeof createExecutionHistory>[0]) {
  try {
    await createExecutionHistory(input);
  } catch (error: any) {
    console.error('Create table audit log failed:', error);
  }
}

// Cadastro explicito de tabela manual. Normalmente a tabela pode nascer pelo
// upload com inferencia de schema, mas este endpoint permite criar antes quando
// o usuario ja conhece as colunas.
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!canCreateTables((session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json(
        { error: 'Sua role não pode cadastrar novas tabelas' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const tableName = normalizeTableName(body.tableName || '');
    const displayName = (body.displayName || tableName).trim();
    const description = body.description?.trim() || null;
    const columns: InferredColumn[] = body.columns;

    const nameError = validateTableName(tableName);
    if (nameError) {
      return NextResponse.json({ error: nameError }, { status: 400 });
    }

    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      return NextResponse.json({ error: 'Defina pelo menos uma coluna' }, { status: 400 });
    }

    const columnsWithWhitespace = columns
      .map((c) => c.name)
      .filter((name) => typeof name === 'string' && /\s/.test(name));
    if (columnsWithWhitespace.length > 0) {
      return NextResponse.json(
        {
          error: `Nomes de coluna não podem conter espaços: ${columnsWithWhitespace.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const existing = await getPipelineConfigByTableName(tableName);
    if (existing) {
      return NextResponse.json(
        { error: `Tabela "${tableName}" já existe. Escolha outro nome ou use a tabela existente.` },
        { status: 409 }
      );
    }

    const normalizedColumns = columns.map((c) => ({
      name: String(c.name).trim(),
      type: String(c.type || 'string').trim().toLowerCase() || 'string',
    }));

    const typeError = validateAthenaColumnTypes(normalizedColumns);
    if (typeError) {
      return NextResponse.json({ error: typeError }, { status: 400 });
    }

    let config = await createPipelineConfig({
      tableName,
      displayName: displayName || tableName.replace(/_/g, ' '),
      requiredColumns: JSON.stringify(normalizedColumns),
      s3Prefix: `${tableName}/`,
      description,
      sourceType: 'file',
      existsInDynamo: false,
      isActive: true,
      manualIngestionEnabled: true,
    });

    const dynamoResult = await updateTableInDynamo(
      tableName,
      normalizedColumns,
      description || undefined,
      true
    );

    if (dynamoResult.success) {
      config = await updatePipelineConfig(config.id, { existsInDynamo: true }) || config;
    }

    const now = new Date();
    await tryCreateExecutionHistory({
      tableName,
      fileName: `Criação de tabela - ${tableName}`,
      status: 'SUCCESS',
      sourceType: 'admin',
      startTime: now,
      endTime: now,
      duration: 0,
      errors: JSON.stringify({
        type: 'Auditoria',
        message: `Tabela ${tableName} criada.`,
        details: {
          action: 'table_created',
          tableName,
          columns: normalizedColumns,
          dynamoMessage: dynamoResult.message,
        },
      }),
      userId: (session.user as any)?.id,
      userEmail: session.user?.email,
      userName: session.user?.name,
    });

    return NextResponse.json({
      success: true,
      table: {
        id: config.id,
        tableName: config.tableName,
        displayName: config.displayName,
        requiredColumns: normalizedColumns,
        s3Prefix: config.s3Prefix,
        description: config.description,
        existsInDynamo: dynamoResult.success,
        manualIngestionEnabled: config.manualIngestionEnabled,
      },
      dynamo: dynamoResult.message,
    });
  } catch (error: any) {
    console.error('Create table error:', error);
    return NextResponse.json({ error: 'Erro ao cadastrar tabela' }, { status: 500 });
  }
}
