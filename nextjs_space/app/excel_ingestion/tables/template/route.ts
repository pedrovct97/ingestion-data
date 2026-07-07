import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import * as XLSX from 'xlsx';
import { authOptions } from '../../../api/auth/[...nextauth]/auth';
import { getPipelineConfigById, getPipelineConfigByTableName } from '@/lib/aws/dynamodb-app-store';

export const dynamic = 'force-dynamic';

const SPECIAL_COLUMN_ORDERS: Record<string, string[]> = {
  de_para_custo_fixo_negocios: [
    'Ano',
    'Linha_Summary_Conta',
    'Grupo_Summary',
    'Linha_Summary',
    'Area',
    'Codigo_Centro_Custo',
    'Codigo_Conta',
    'Versao',
    'Centro_Custo',
    'Conta',
    'Total_Meses',
    'Jan',
    'Fev',
    'Mar',
    'Abr',
    'Mai',
    'Jun',
    'Jul',
    'Ago',
    'Set',
    'Out',
    'Nov',
    'Dez',
    'Area_integration',
    'Alocacao_custos',
    'Flag_centro_custo',
    'Flag_Conta',
    'Conta_Considerada',
  ],
  de_para_produtos: [
    'Codigo_produto',
    'Nome_produto',
    'Codigo_Grupo_Material_1',
    'Descricao_Grupo_Material_1',
    'Codigo_Grupo_Material_2',
    'Descricao_Grupo_Material_2',
    'Codigo_Grupo_Material_3',
    'Descricao_Grupo_Material_3',
    'Codigo_Grupo_Material_4',
    'Descricao_Grupo_Material_4',
    'Codigo_Grupo_Material_5',
    'Descricao_Grupo_Material_5',
    'Produto_PnL_G1',
    'Produto_PnL_G2',
    'Produto_PnL_G3',
    'Produto_PnL_COGS',
    'Descricao_Grupo_Variavel_Vendas',
    'Descricao_Grupo_Variavel_Comissao',
    'Codigo_Pallets',
    'Parametro_Considerar',
    'Mes_competencia',
    'Centro_de_Lucro',
    'Descricao_Centro_de_Lucro',
    'Flag_de_Capsulas',
  ],
  de_para_geral_clientes: [
    'CNPJ_cliente',
    'CNPJ_raiz',
    'Nome_BaseNF',
    'Rede_Agrupada',
    'Codigo_cliente',
    'Cliente_trade_fixo',
    'Rua',
    'Local',
    'Bairro',
    'Estado_UF',
    'Codigo_Postal',
    'Local_Estado',
    'Mes_competencia',
  ],
  de_para_geral_regiao: [
    'Rg',
    'Regiao_Venda_desc',
    'Cod_Regiao_Venda',
    'Codigo',
    'Chave_Rg_RegiaoVenda',
    'Rg_Trade',
    'Regiao_salario',
    'Parametro_Considerar',
    'Mes_competencia',
  ],
  de_para_geral_canal: [
    'Descricao_Canal',
    'Cod_descricao_Canal',
    'Codigo',
    'Canal_Trade',
    'Parametro_Considerar',
    'Mes_competencia',
  ],
};

function parseColumns(value: string) {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((column) => ({
        name: typeof column === 'string' ? column : String(column?.name || ''),
        type: typeof column === 'string' ? 'string' : String(column?.type || 'string'),
      }))
      .filter((column) => column.name.trim().length > 0);
  } catch {
    return [];
  }
}

function safeFileName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '');
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function orderColumns(tableName: string, columns: Array<{ name: string; type: string }>) {
  const specialOrder = SPECIAL_COLUMN_ORDERS[normalizeKey(tableName)];
  if (!specialOrder) return columns;

  const columnsByName = new Map(columns.map((column) => [column.name.trim(), column]));
  const ordered = specialOrder
    .map((name) => columnsByName.get(name))
    .filter(Boolean) as Array<{ name: string; type: string }>;
  const orderedNames = new Set(ordered.map((column) => column.name.trim()));
  const remaining = columns.filter((column) => !orderedNames.has(column.name.trim()));

  return [...ordered, ...remaining];
}

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const tableName = searchParams.get('tableName') || '';

    if (!tableName) {
      return NextResponse.json({ error: 'Tabela não informada' }, { status: 400 });
    }

    const config =
      (await getPipelineConfigByTableName(tableName)) ||
      (await getPipelineConfigById(tableName));

    if (!config) {
      return NextResponse.json({ error: 'Tabela não encontrada' }, { status: 404 });
    }

    const columns = orderColumns(config.tableName || tableName, parseColumns(config.requiredColumns));
    if (columns.length === 0) {
      return NextResponse.json(
        { error: 'Tabela não possui colunas configuradas para gerar modelo' },
        { status: 400 }
      );
    }

    const headerRow = columns.map((column) => column.name.trim());
    const worksheet = XLSX.utils.aoa_to_sheet([headerRow]);

    worksheet['!cols'] = headerRow.map((name) => ({
      wch: Math.max(name.length + 4, 14),
    }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'modelo');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const fileName = `modelo_${safeFileName(config.tableName || tableName)}.xlsx`;

    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-File-Name': encodeURIComponent(fileName),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Template download error:', error);
    return NextResponse.json({ error: 'Erro ao gerar modelo da tabela' }, { status: 500 });
  }
}
