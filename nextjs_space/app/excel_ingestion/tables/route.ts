import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]/auth';
import { hasRouteAccess } from '@/lib/auth/roles';
import {
  createExecutionHistory,
  getPipelineConfigById,
  listPipelineConfigs,
  updatePipelineConfig,
} from '@/lib/aws/dynamodb-app-store';

export const dynamic = 'force-dynamic';

const ATHENA_COLUMN_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date'];

type Column = { name: string; type: string };

function parseRequiredColumns(value: string) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapTableConfig(config: any) {
  return {
    id: config.id,
    tableName: config.tableName,
    displayName: config.displayName,
    requiredColumns: parseRequiredColumns(config.requiredColumns),
    s3Prefix: config.s3Prefix,
    description: config.description,
    sourceType: config.sourceType,
    existsInDynamo: config.existsInDynamo,
    manualIngestionEnabled: config.manualIngestionEnabled,
    createdAt: config.createdAt,
  };
}

function dedupeTablesByName(tables: any[]) {
  const byName = new Map<string, any>();
  for (const table of tables) {
    const key = String(table.tableName || '').trim().toLowerCase();
    if (!key) continue;
    const current = byName.get(key);
    if (!current || table.manualIngestionEnabled === false) {
      byName.set(key, table);
    }
  }
  return Array.from(byName.values());
}

function normalizeColumns(columns: any[]) {
  return columns.map((column) => ({
    name: String(typeof column === 'string' ? column : column?.name || '').trim(),
    type: String(typeof column === 'string' ? 'string' : column?.type || 'string').trim().toLowerCase(),
  }));
}

function validateAthenaColumnTypes(columns: { name: string; type: string }[]) {
  const invalidColumns = columns.filter((column) => !ATHENA_COLUMN_TYPES.includes(column.type));
  if (invalidColumns.length === 0) return null;

  const invalidList = invalidColumns
    .map((column) => `${column.name || '(sem nome)'} (${column.type || 'sem tipo'})`)
    .join(', ');

  return `Tipos inválidos para Athena: ${invalidList}. Tipos permitidos: ${ATHENA_COLUMN_TYPES.join(', ')}.`;
}

function sameColumnNames(oldColumns: { name?: string }[], newColumns: { name?: string }[]) {
  if (oldColumns.length !== newColumns.length) return false;
  return oldColumns.every((column, index) =>
    String(column.name || '').trim() === String(newColumns[index]?.name || '').trim()
  );
}

function typesMatch(expectedColumns: Column[], actualColumns: Column[]) {
  const actualByName = new Map(actualColumns.map((column) => [column.name, column.type]));
  return expectedColumns.every((column) => actualByName.get(column.name) === column.type);
}

async function createAuditHistory(input: {
  tableName: string;
  fileName: string;
  message: string;
  details?: any;
  session: any;
}) {
  const now = new Date();
  await createExecutionHistory({
    tableName: input.tableName,
    fileName: input.fileName,
    status: 'SUCCESS',
    sourceType: 'admin',
    startTime: now,
    endTime: now,
    duration: 0,
    errors: JSON.stringify({
      type: 'Auditoria',
      message: input.message,
      details: input.details,
    }),
    userId: input.session?.user?.id,
    userEmail: input.session?.user?.email,
    userName: input.session?.user?.name,
  });
}

async function tryCreateAuditHistory(input: Parameters<typeof createAuditHistory>[0]) {
  try {
    await createAuditHistory(input);
  } catch (error: any) {
    console.error('Table audit log failed:', error);
  }
}

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const sourceType = searchParams.get('sourceType');
    const manualIngestionOnly = searchParams.get('manualIngestionOnly') === 'true';

    const configs = await listPipelineConfigs({
      sourceType: sourceType || undefined,
      activeOnly: true,
    });
    const tables = dedupeTablesByName(configs.map(mapTableConfig));
    const visibleTables = manualIngestionOnly
      ? tables.filter((table) => table.manualIngestionEnabled !== false)
      : tables;

    return NextResponse.json({ tables: visibleTables });
  } catch (error: any) {
    console.error('Error fetching tables:', error);
    return NextResponse.json({ error: 'Erro ao buscar tabelas' }, { status: 500 });
  }
}

export async function POST(_req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  if (!hasRouteAccess('/tabelas', (session.user as any)?.role, (session.user as any)?.permissions)) {
    return NextResponse.json({ error: 'Sua role não pode cadastrar tabelas' }, { status: 403 });
  }

  return NextResponse.json(
    { error: 'Cadastro manual de tabelas foi desativado. O schema agora é inferido no Upload.' },
    { status: 410 }
  );
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!hasRouteAccess('/tabelas', (session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json({ error: 'Sua role não pode editar tabelas' }, { status: 403 });
    }

    const body = await req.json();
    const { id, tableName, columns, manualIngestionEnabled } = body;

    if (!id) {
      return NextResponse.json({ error: 'ID é obrigatório' }, { status: 400 });
    }

    const hasColumnsPayload = columns !== undefined;
    const hasManualTogglePayload = manualIngestionEnabled !== undefined;
    const normalizedColumns = hasColumnsPayload && Array.isArray(columns) ? normalizeColumns(columns) : [];

    if (!hasColumnsPayload && !hasManualTogglePayload) {
      return NextResponse.json({ error: 'Nenhuma alteração enviada' }, { status: 400 });
    }

    if (hasColumnsPayload && (!Array.isArray(columns) || columns.length === 0)) {
      return NextResponse.json({ error: 'Defina pelo menos uma coluna' }, { status: 400 });
    }

    if (hasColumnsPayload) {
      const emptyColumns = normalizedColumns.filter((column) => !column.name);
      if (emptyColumns.length > 0) {
        return NextResponse.json({ error: 'Todas as colunas precisam ter nome' }, { status: 400 });
      }

      const typeError = validateAthenaColumnTypes(normalizedColumns);
      if (typeError) {
        return NextResponse.json({ error: typeError }, { status: 400 });
      }
    }

    const existing = await getPipelineConfigById(id) ||
      (tableName ? await getPipelineConfigById(tableName) : null);
    if (!existing) {
      return NextResponse.json({ error: 'Tabela não encontrada' }, { status: 404 });
    }

    const updateId = existing.id || existing.s3Prefix || existing.tableName || id;
    const oldColumns = parseRequiredColumns(existing.requiredColumns);

    if (hasColumnsPayload && !sameColumnNames(oldColumns, normalizedColumns)) {
      return NextResponse.json(
        { error: 'Nesta tela, é permitido alterar somente o tipo das colunas já existentes no data_schema.' },
        { status: 400 }
      );
    }

    const columnsChanged =
      hasColumnsPayload && JSON.stringify(oldColumns) !== JSON.stringify(normalizedColumns);

    let updated = await updatePipelineConfig(updateId, {
      ...(hasColumnsPayload ? { requiredColumns: JSON.stringify(normalizedColumns) } : {}),
      ...(hasManualTogglePayload ? { manualIngestionEnabled: Boolean(manualIngestionEnabled) } : {}),
    });

    if (!updated) {
      return NextResponse.json({ error: 'Tabela não encontrada para atualização.' }, { status: 404 });
    }

    if (hasColumnsPayload) {
      const updatedColumns = parseRequiredColumns(updated.requiredColumns);
      if (!typesMatch(normalizedColumns, updatedColumns)) {
        return NextResponse.json(
          { error: 'O DynamoDB não confirmou a alteração dos tipos no data_schema.' },
          { status: 500 }
        );
      }
    }

    if (hasManualTogglePayload && !hasColumnsPayload) {
      const normalize = (value?: string | null) => String(value || '').trim().toLowerCase();
      const tableKeys = new Set([
        normalize(existing.tableName),
        normalize(existing.displayName),
        normalize(tableName),
      ].filter(Boolean));
      const relatedConfigs = (await listPipelineConfigs({
        sourceType: existing.sourceType || 'file',
        activeOnly: true,
      })).filter((config) =>
        [
          config.tableName,
          config.displayName,
          config.id,
          config.s3Prefix,
        ].some((value) => tableKeys.has(normalize(value)))
      );

      for (const config of relatedConfigs) {
        updated = await updatePipelineConfig(
          config.id || config.s3Prefix || config.tableName,
          { manualIngestionEnabled: Boolean(manualIngestionEnabled) }
        ) || updated;
      }
    }

    const propagation = {
      dynamo: hasColumnsPayload
        ? 'Tipos das colunas atualizados no data_schema.'
        : 'Permissão de ingestão manual atualizada.',
      dataLake: 'Nenhuma Step Function foi acionada.',
    };

    await tryCreateAuditHistory({
      tableName: existing.tableName,
      fileName: hasColumnsPayload
        ? `Edição de tipos - ${existing.tableName}`
        : `${Boolean(manualIngestionEnabled) ? 'Liberação' : 'Bloqueio'} de ingestão manual - ${existing.tableName}`,
      message: hasColumnsPayload
        ? `Tipos do data_schema da tabela ${existing.tableName} editados.`
        : `Ingestão manual ${Boolean(manualIngestionEnabled) ? 'liberada' : 'bloqueada'} para ${existing.tableName}.`,
      details: {
        action: hasColumnsPayload ? 'data_schema_types_updated' : 'manual_ingestion_toggled',
        tableName: existing.tableName,
        columnsChanged,
        oldColumns: hasColumnsPayload ? oldColumns : undefined,
        newColumns: hasColumnsPayload ? normalizedColumns : undefined,
        manualIngestionEnabled: hasManualTogglePayload ? Boolean(manualIngestionEnabled) : undefined,
      },
      session,
    });

    return NextResponse.json({
      success: true,
      message: 'Tabela atualizada com sucesso.',
      propagation,
      table: {
        id: updated?.id,
        tableName: updated?.tableName,
        displayName: updated?.displayName,
        requiredColumns: parseRequiredColumns(updated?.requiredColumns || '[]'),
        sourceType: updated?.sourceType,
        description: updated?.description,
        manualIngestionEnabled: updated?.manualIngestionEnabled,
      },
    });
  } catch (error: any) {
    console.error('Error updating table config:', error);
    return NextResponse.json(
      { error: error?.message || 'Erro ao atualizar tabela' },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  if (!hasRouteAccess('/tabelas', (session.user as any)?.role, (session.user as any)?.permissions)) {
    return NextResponse.json({ error: 'Sua role não pode remover tabelas' }, { status: 403 });
  }

  return NextResponse.json(
    { error: 'Remoção manual de tabelas foi desativada.' },
    { status: 410 }
  );
}
