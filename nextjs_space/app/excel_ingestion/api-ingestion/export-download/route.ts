import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]/auth';
import { hasRouteAccess } from '@/lib/auth/roles';
import { getProcessExportFileObject } from '@/lib/aws/s3-service';
import { createExecutionHistory } from '@/lib/aws/dynamodb-app-store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!hasRouteAccess('/api-ingestao', (session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json({ error: 'Sua role não pode baixar extrações' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const period = searchParams.get('period') || '';

    if (!/^\d{4}-\d{2}$/.test(period)) {
      return NextResponse.json({ error: 'period deve estar no formato YYYY-MM' }, { status: 400 });
    }

    const download = await getProcessExportFileObject(period);
    if (!download) {
      const now = new Date();
      await createExecutionHistory({
        tableName: 'download:lucro_bruto',
        fileName: `lucro_bruto_${period}`,
        status: 'ERROR',
        sourceType: 'download',
        errors: 'Arquivo não disponível para o período selecionado',
        userId: (session.user as any)?.id,
        userEmail: session.user?.email,
        userName: session.user?.name,
        startTime: now,
        endTime: now,
      });

      return NextResponse.json(
        { error: 'Arquivo não disponível para o período selecionado' },
        { status: 404 }
      );
    }

    const body = new Uint8Array(download.bytes);
    const now = new Date();

    await createExecutionHistory({
      tableName: 'download:lucro_bruto',
      fileName: download.file.fileName,
      fileSize: download.bytes.byteLength,
      status: 'SUCCESS',
      sourceType: 'download',
      userId: (session.user as any)?.id,
      userEmail: session.user?.email,
      userName: session.user?.name,
      startTime: now,
      endTime: now,
    });

    return new Response(body, {
      headers: {
        'Content-Type': download.contentType,
        'Content-Disposition': `attachment; filename="${download.file.fileName}"`,
        'X-File-Name': encodeURIComponent(download.file.fileName),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: any) {
    console.error('Process export download error:', error);
    return NextResponse.json({ error: 'Erro ao baixar arquivo' }, { status: 500 });
  }
}
