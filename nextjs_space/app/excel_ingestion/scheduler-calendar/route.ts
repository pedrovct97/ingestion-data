import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../api/auth/[...nextauth]/auth';
import { uploadSchedulerCalendarToS3 } from '@/lib/aws/s3-service';
import { hasRouteAccess } from '@/lib/auth/roles';
import { createExecutionHistory } from '@/lib/aws/dynamodb-app-store';
import { getXlsxHeaderNames } from '@/lib/xlsx-inference';

export const dynamic = 'force-dynamic';

// Importacao do calendario de execucao.
// A aplicacao envia o XLSX para S3 e registra historico como SUCCESS quando a
// entrega ao bucket conclui. A Lambda
// extraction-scheduler escuta o S3 e cria as datas no
// EventBridge Scheduler fora da aplicacao.
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    if (!hasRouteAccess('/scheduler-calendar', (session.user as any)?.role, (session.user as any)?.permissions)) {
      return NextResponse.json(
        { error: 'Sua role não pode importar o calendário de execução' },
        { status: 403 }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'Arquivo e obrigatorio' }, { status: 400 });
    }

    if (!file.name.endsWith('.xlsx')) {
      return NextResponse.json({ error: 'Apenas arquivos .xlsx são permitidos' }, { status: 400 });
    }

    const maxSize = 25 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: 'Arquivo muito grande. Tamanho máximo: 25MB' },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const headers = getXlsxHeaderNames(buffer);
    const normalizedHeaders = headers.map((header) => header.trim().toLowerCase());

    // Contrato esperado pela Lambda scheduler: o arquivo deve ter somente a
    // coluna execution_date. Bloqueamos colunas extras ou nome divergente antes
    // de enviar ao S3, evitando que a Lambda processe um calendario invalido.
    if (normalizedHeaders.length !== 1 || normalizedHeaders[0] !== 'execution_date') {
      return NextResponse.json(
        {
          error: `Arquivo inválido. O calendário deve conter somente a coluna execution_date. Colunas encontradas: ${headers.length ? headers.join(', ') : 'nenhuma'}`,
        },
        { status: 400 }
      );
    }

    const startedAt = new Date();
    const result = await uploadSchedulerCalendarToS3(
      buffer,
      file.name,
      file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Erro ao enviar calendário para S3' },
        { status: 500 }
      );
    }

    const finishedAt = new Date();
    // sourceType=calendar diferencia este registro dos uploads manuais e dos
    // reprocessamentos API nas telas de historico/monitoramento.
    await createExecutionHistory({
      tableName: 'scheduler_calendar',
      fileName: result.key || file.name,
      fileSize: file.size,
      status: 'SUCCESS',
      sourceType: 'calendar',
      startTime: startedAt,
      endTime: finishedAt,
      duration: Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)),
      errors: null,
      userId: (session.user as any)?.id,
      userEmail: session.user?.email,
      userName: session.user?.name,
    });

    return NextResponse.json({
      success: true,
      message: 'Calendário importado com sucesso',
      bucket: result.bucket,
      key: result.key,
      s3Uri: result.s3Uri,
    });
  } catch (error: any) {
    console.error('Scheduler calendar upload error:', error);
    return NextResponse.json({ error: 'Erro ao importar calendário' }, { status: 500 });
  }
}
