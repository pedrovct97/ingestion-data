import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]/auth';
import { getPipelineConfigById } from '@/lib/aws/dynamodb-app-store';
import {
  parseColumnsJson,
  validateSchemaAgainstXlsx,
  formatColumnValidationError,
} from '@/lib/xlsx-inference';

export const dynamic = 'force-dynamic';

// Validacao de arquivo contra schema existente ou schema enviado pela UI.
// Usado para bloquear upload quando faltam colunas obrigatorias.
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const tableName = (formData.get('tableName') as string) || '';
    const columnsJson = formData.get('columns') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'Arquivo é obrigatório' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let expectedColumns = columnsJson ? parseColumnsJson(columnsJson) : null;

    if (!expectedColumns && tableName) {
      const config = await getPipelineConfigById(tableName);
      if (config) {
        expectedColumns = JSON.parse(config.requiredColumns || '[]');
      }
    }

    if (!expectedColumns || expectedColumns.length === 0) {
      return NextResponse.json(
        {
          error: tableName
            ? `Schema da tabela "${tableName}" não encontrado para validação`
            : 'Informe as colunas do schema ou selecione uma tabela configurada',
        },
        { status: 400 }
      );
    }

    const validation = validateSchemaAgainstXlsx(buffer, expectedColumns);

    return NextResponse.json({
      ...validation,
      error: validation.valid ? undefined : formatColumnValidationError(validation),
    });
  } catch (error: any) {
    console.error('Validate columns error:', error);
    return NextResponse.json({ error: 'Erro ao validar colunas' }, { status: 500 });
  }
}
