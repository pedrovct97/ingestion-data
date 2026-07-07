import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import * as XLSX from 'xlsx';
import { authOptions } from '../../../api/auth/[...nextauth]/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const worksheet = XLSX.utils.aoa_to_sheet([
      ['execution_date'],
      ['2026-05-31'],
    ]);

    worksheet['!cols'] = [{ wch: 18 }];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'modelo');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const fileName = 'modelo_scheduler_calendar.xlsx';

    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-File-Name': encodeURIComponent(fileName),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Scheduler calendar template download error:', error);
    return NextResponse.json({ error: 'Erro ao gerar modelo do calendário' }, { status: 500 });
  }
}
