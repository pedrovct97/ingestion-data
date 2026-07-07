import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]/auth';
import { uploadFileToS3 } from '@/lib/aws/s3-service';
import {
  inferColumnsFromXlsx,
  parseColumnsJson,
  normalizeTableName,
  validateSchemaAgainstXlsx,
  formatColumnValidationError,
  type InferredColumn,
} from '@/lib/xlsx-inference';
import { updateTableInDynamo } from '@/lib/aws/dynamodb-service';
import { canCreateTables } from '@/lib/auth/roles';
import {
  createExecutionHistory,
  createPipelineConfig,
  getPipelineConfigByTableName,
  listPipelineConfigs,
  updatePipelineConfig,
} from '@/lib/aws/dynamodb-app-store';

export const dynamic = 'force-dynamic';

const ATHENA_COLUMN_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date'];

function validateAthenaColumnTypes(columns: InferredColumn[] | null) {
  if (!columns) return null;
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
    console.error('Upload audit log failed:', error);
  }
}

// Endpoint de upload manual.
// Fluxo:
// 1. Valida usuario e arquivo XLSX.
// 2. Confere/infere schema e sincroniza DynamoDB quando necessario.
// 3. Envia o XLSX ao S3 transient.
// 4. Registra historico como CRAWLING, pois a Lambda + Glue Crawler continuam
//    o processamento fora da aplicacao.
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const tableName = normalizeTableName((formData.get('tableName') as string) || '');
    const columnsJson = formData.get('columns') as string | null;

    if (!file || !tableName) {
      return NextResponse.json(
        { error: 'Arquivo e nome da tabela são obrigatórios' },
        { status: 400 }
      );
    }

    if (!file.name.endsWith('.xlsx')) {
      return NextResponse.json(
        { error: 'Apenas arquivos .xlsx são permitidos' },
        { status: 400 }
      );
    }

    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: 'Arquivo muito grande. Tamanho máximo: 50MB' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let config = await getPipelineConfigByTableName(tableName);
    const canManageTables = canCreateTables(
      (session.user as any)?.role,
      (session.user as any)?.permissions
    );

    const relatedTableConfigs = await listPipelineConfigs({
      sourceType: 'file',
      activeOnly: true,
    });
    const normalizedTableName = tableName.trim().toLowerCase();
    const hasManualBlock = relatedTableConfigs.some((item) => {
      const keys = [
        item.tableName,
        item.displayName,
        item.id,
        item.s3Prefix,
      ].map((value) => String(value || '').trim().toLowerCase());

      return item.manualIngestionEnabled === false && keys.includes(normalizedTableName);
    });

    if ((config && config.manualIngestionEnabled === false) || hasManualBlock) {
      return NextResponse.json(
        { error: 'Esta tabela não permite ingestão manual de arquivos' },
        { status: 403 }
      );
    }

    // Schema esperado vem do formulario quando o usuario esta criando/editando
    // a tabela; caso contrario vem do cadastro salvo no DynamoDB.
    const resolveExpectedColumns = (): InferredColumn[] | null => {
      const fromForm = columnsJson ? parseColumnsJson(columnsJson) : null;
      if (fromForm?.length) return fromForm;
      if (config) {
        try {
          const parsed = JSON.parse(config.requiredColumns || '[]');
          return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
        } catch {
          return null;
        }
      }
      return null;
    };

    const expectedForValidation = resolveExpectedColumns();
    if (expectedForValidation) {
      const validation = validateSchemaAgainstXlsx(buffer, expectedForValidation);
      if (!validation.valid) {
        const errorMessage = formatColumnValidationError(validation);
        const now = new Date();

        await createExecutionHistory({
          tableName,
          fileName: file.name,
          fileSize: file.size,
          status: 'ERROR',
          sourceType: 'file',
          startTime: now,
          endTime: now,
          errors: JSON.stringify({
            type: 'ManualUploadValidationError',
            message: errorMessage,
            details: validation,
          }),
          userId: (session.user as any)?.id,
          userEmail: session.user?.email,
          userName: session.user?.name,
        });

        return NextResponse.json(
          {
            error: errorMessage,
            validation,
          },
          { status: 400 }
        );
      }
    }

    if (!config) {
      // Tabela ainda nao cadastrada: somente usuarios com permissao podem criar
      // o item no DynamoDB que a Lambda manual consulta.
      if (!canManageTables) {
        return NextResponse.json(
          { error: 'Seu usuário pode importar apenas para tabelas existentes' },
          { status: 403 }
        );
      }

      const userColumns = columnsJson ? parseColumnsJson(columnsJson) : null;
      const typeError = validateAthenaColumnTypes(userColumns);
      if (typeError) {
        return NextResponse.json({ error: typeError }, { status: 400 });
      }
      const inferredColumns = userColumns || inferColumnsFromXlsx(buffer);

      if (inferredColumns.length === 0) {
        return NextResponse.json(
          { error: 'Não foi possível inferir colunas do Excel (cabeçalho ausente).' },
          { status: 400 }
        );
      }

      const columnsWithWhitespace = inferredColumns
        .map((column) => column.name)
        .filter((columnName) => /\s/.test(columnName));
      if (columnsWithWhitespace.length > 0) {
        return NextResponse.json(
          {
            error: `Column names não podem conter espaços em branco: ${columnsWithWhitespace.join(', ')}`,
          },
          { status: 400 }
        );
      }

      const displayName = tableName
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase());

      config = await createPipelineConfig({
        tableName,
        displayName,
        requiredColumns: JSON.stringify(inferredColumns),
        s3Prefix: `${tableName}/`,
        sourceType: 'file',
        existsInDynamo: false,
        isActive: true,
      });

      const dynamoResult = await updateTableInDynamo(tableName, inferredColumns, displayName, true);
      if (dynamoResult.success) {
        config = await updatePipelineConfig(config.id, { existsInDynamo: true }) || config;
      }

      const now = new Date();
      await tryCreateExecutionHistory({
        tableName,
        fileName: `Criação de tabela via upload - ${tableName}`,
        status: 'SUCCESS',
        sourceType: 'admin',
        startTime: now,
        endTime: now,
        duration: 0,
        errors: JSON.stringify({
          type: 'Auditoria',
          message: `Tabela ${tableName} criada via Upload.`,
          details: {
            action: 'table_created_from_upload',
            tableName,
            columns: inferredColumns,
            dynamoMessage: dynamoResult.message,
          },
        }),
        userId: (session.user as any)?.id,
        userEmail: session.user?.email,
        userName: session.user?.name,
      });
    } else if (columnsJson) {
      // Tabela existente com schema enviado pela UI: atualiza DynamoDB antes de
      // subir o arquivo, garantindo que a Lambda leia o schema mais recente.
      if (!canManageTables) {
        return NextResponse.json(
          { error: 'Seu usuário não pode alterar o schema da tabela' },
          { status: 403 }
        );
      }

      const userColumns = parseColumnsJson(columnsJson);
      const typeError = validateAthenaColumnTypes(userColumns);
      if (typeError) {
        return NextResponse.json({ error: typeError }, { status: 400 });
      }
      if (userColumns && userColumns.length > 0) {
        await updatePipelineConfig(config.id, { requiredColumns: JSON.stringify(userColumns) });
        await updateTableInDynamo(
          tableName,
          userColumns,
          config.description || undefined,
          config.manualIngestionEnabled
        );

        const now = new Date();
        await tryCreateExecutionHistory({
          tableName,
          fileName: `Edição de tabela via upload - ${tableName}`,
          status: 'SUCCESS',
          sourceType: 'admin',
          startTime: now,
          endTime: now,
          duration: 0,
          errors: JSON.stringify({
            type: 'Auditoria',
            message: `Schema da tabela ${tableName} editado via Upload.`,
            details: {
              action: 'table_updated_from_upload',
              tableName,
              columns: userColumns,
            },
          }),
          userId: (session.user as any)?.id,
          userEmail: session.user?.email,
          userName: session.user?.name,
        });
      }
    }

    const periodMatch = file.name.match(/[_-](\d{4})[_-](\d{2})\.xlsx$/i);
    const periodSuffix = periodMatch
      ? `_${periodMatch[1]}_${periodMatch[2]}.xlsx`
      : '.xlsx';
    const uploadFileName = `${tableName}${periodSuffix.toLowerCase()}`;

    const uploadResult = await uploadFileToS3(
      buffer,
      uploadFileName,
      tableName,
      file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    if (!uploadResult.success) {
      return NextResponse.json(
        { error: uploadResult.error || 'Erro ao enviar o arquivo' },
        { status: 500 }
      );
    }

    // Upload manual nao possui executionArn porque nao chama Step Function.
    // O refresh posterior usa tableName/fileName para descobrir o Glue Crawler.
    const execution = await createExecutionHistory({
      tableName,
      fileName: uploadFileName,
      fileSize: file.size,
      status: 'CRAWLING',
      userId: (session.user as any)?.id,
      userEmail: session.user?.email,
      userName: session.user?.name,
    });

    return NextResponse.json({
      success: true,
      execution: {
        id: execution.id,
        executionArn: execution.executionArn,
        tableName: execution.tableName,
        fileName: execution.fileName,
        originalFileName: file.name,
        status: execution.status,
      },
    });
  } catch (error: any) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Erro ao processar o envio' },
      { status: 500 }
    );
  }
}
