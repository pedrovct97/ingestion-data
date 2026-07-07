import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]/auth';
import { inferColumnsFromXlsx } from '@/lib/xlsx-inference';

export const dynamic = 'force-dynamic';

// Preview de schema: le o XLSX sem salvar nada e retorna colunas/tipos inferidos
// para a UI permitir revisao antes de criar ou importar a tabela.
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'Arquivo é obrigatório' }, { status: 400 });
    }

    if (!file.name.endsWith('.xlsx')) {
      return NextResponse.json({ error: 'Apenas arquivos .xlsx são permitidos' }, { status: 400 });
    }

    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json({ error: 'Arquivo muito grande. Máximo: 50MB' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const columns = inferColumnsFromXlsx(buffer);

    if (columns.length === 0) {
      return NextResponse.json(
        { error: 'Não foi possível inferir colunas (cabeçalho ausente na primeira aba).' },
        { status: 400 }
      );
    }

    const columnsWithWhitespace = columns
      .map((c) => c.name)
      .filter((name) => /\s/.test(name));
    if (columnsWithWhitespace.length > 0) {
      return NextResponse.json(
        {
          error: `Nomes de coluna não podem conter espaços: ${columnsWithWhitespace.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const fileHeaders = columns.map((c) => c.name);

    return NextResponse.json({
      success: true,
      fileName: file.name,
      columns,
      fileHeaders,
      rowSampleSize: 100,
    });
  } catch (error: any) {
    console.error('Preview error:', error);
    return NextResponse.json({ error: 'Erro ao analisar arquivo' }, { status: 500 });
  }
}
