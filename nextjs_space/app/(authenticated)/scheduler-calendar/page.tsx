'use client';

import { useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from 'lucide-react';

export default function SchedulerCalendarPage() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [s3Uri, setS3Uri] = useState('');

  const handleDownloadTemplate = async () => {
    setError('');
    try {
      const response = await fetch('/excel_ingestion/scheduler-calendar/template');
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Erro ao baixar modelo');
      }

      const blob = await response.blob();
      const encodedFileName = response.headers.get('X-File-Name');
      const disposition = response.headers.get('Content-Disposition') || '';
      const fileName =
        (encodedFileName ? decodeURIComponent(encodedFileName) : null) ||
        disposition.match(/filename="([^"]+)"/)?.[1] ||
        'modelo_scheduler_calendar.xlsx';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err?.message || 'Erro ao baixar modelo');
    }
  };

  // Valida apenas o contrato minimo da tela. A validacao do conteudo do Excel
  // fica com a Lambda scheduler, que conhece o formato esperado das datas.
  const handleFileSelect = (selectedFile: File) => {
    setError('');
    setSuccess('');
    setS3Uri('');

    if (!selectedFile.name.endsWith('.xlsx')) {
      setError('Apenas arquivos .xlsx são permitidos');
      return;
    }

    if (selectedFile.size > 25 * 1024 * 1024) {
      setError('Arquivo muito grande. Tamanho máximo: 25MB');
      return;
    }

    setFile(selectedFile);
  };

  // Envia o calendario para S3. Apos upload, a Lambda de scheduler escuta o
  // bucket/prefixo e cria os agendamentos no EventBridge Scheduler.
  const handleUpload = async () => {
    if (!file) {
      setError('Selecione o arquivo de calendário');
      return;
    }

    setIsUploading(true);
    setError('');
    setSuccess('');
    setS3Uri('');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/excel_ingestion/scheduler-calendar', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Erro ao importar calendário');
      }

      setSuccess(data.message || 'Calendário importado com sucesso');
      setS3Uri(data.s3Uri || '');
      setFile(null);
    } catch (err: any) {
      setError(err?.message || 'Erro ao importar calendário');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-[#730401] mb-1">Calendário de Execução</h1>
        <p className="text-gray-500">
          Importe o Excel que será lido pela Lambda para atualizar o EventBridge Scheduler.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-11 h-11 bg-[#730401]/10 rounded-lg flex items-center justify-center">
              <CalendarDays className="w-6 h-6 text-[#730401]" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Arquivo do calendário</h2>
              <p className="text-sm text-gray-400 font-mono">
                Destino configurado pelas variáveis AWS_S3_SCHEDULER_CALENDAR_BUCKET e AWS_S3_SCHEDULER_CALENDAR_PREFIX
              </p>
            </div>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="ml-auto inline-flex items-center gap-2 px-3 py-2 border border-[#730401]/20 text-[#730401] rounded-lg hover:bg-[#730401]/5 text-xs font-semibold whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              Baixar modelo
            </button>
          </div>

          <div className="border-2 border-dashed rounded-xl p-8 text-center border-gray-200 hover:border-[#730401]/40 hover:bg-gray-50 transition-all">
            <input
              type="file"
              id="scheduler-calendar-upload"
              accept=".xlsx"
              onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
              className="hidden"
            />
            <label htmlFor="scheduler-calendar-upload" className="cursor-pointer">
              <div className="flex flex-col items-center">
                <div className="w-14 h-14 bg-[#730401]/10 rounded-full flex items-center justify-center mb-4">
                  <Upload className="w-7 h-7 text-[#730401]" />
                </div>
                <p className="text-gray-700 font-medium mb-1">
                  Clique para selecionar o calendário
                </p>
                <p className="text-sm text-gray-400">Apenas .xlsx (máx. 25MB)</p>
              </div>
            </label>
          </div>

          {file && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <FileSpreadsheet className="w-5 h-5 text-[#730401]" />
                <div>
                  <p className="text-sm text-gray-900 font-medium">{file.name}</p>
                  <p className="text-xs text-gray-400">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFile(null)}
                className="text-sm text-[#730401]/80 hover:text-[#730401] font-medium"
              >
                Remover
              </button>
            </div>
          )}

          {error && (
            <div className="mt-4 p-3 bg-[#730401]/5 border border-[#730401]/20 rounded-lg flex items-start space-x-2">
              <AlertCircle className="w-5 h-5 text-[#730401] flex-shrink-0 mt-0.5" />
              <p className="text-sm text-[#730401]">{error}</p>
            </div>
          )}

          {success && (
            <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-start space-x-2">
              <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-green-700">{success}</p>
                {s3Uri && <p className="text-xs text-green-700 font-mono mt-1">{s3Uri}</p>}
              </div>
            </div>
          )}

          <button
            onClick={handleUpload}
            disabled={!file || isUploading}
            className="mt-5 w-full py-3 px-4 bg-[#730401] text-white font-medium rounded-lg hover:bg-[#5f0301] focus:outline-none focus:ring-2 focus:ring-[#730401]/40 focus:ring-offset-2 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Enviando...
              </>
            ) : (
              'Importar calendário'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
