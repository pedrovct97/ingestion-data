'use client';

import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-react';

interface ExecutionStatusProps {
  executionId: string;
}

interface Execution {
  id: string;
  tableName: string;
  fileName: string;
  status: string;
  startTime: string;
  endTime?: string;
  duration?: number;
  errors?: string;
}

const statusConfig: any = {
  UPLOADING: { label: 'Enviando arquivo', color: 'text-blue-600', bgColor: 'bg-blue-50', borderColor: 'border-blue-200', icon: Loader2, animate: true },
  RUNNING: { label: 'Em Execução', color: 'text-amber-600', bgColor: 'bg-amber-50', borderColor: 'border-amber-200', icon: Loader2, animate: true },
  CONVERTING: { label: 'Convertendo', color: 'text-blue-600', bgColor: 'bg-blue-50', borderColor: 'border-blue-200', icon: Loader2, animate: true },
  CRAWLING: { label: 'Catalogando', color: 'text-purple-600', bgColor: 'bg-purple-50', borderColor: 'border-purple-200', icon: Loader2, animate: true },
  VALIDATING: { label: 'Validando', color: 'text-indigo-600', bgColor: 'bg-indigo-50', borderColor: 'border-indigo-200', icon: Loader2, animate: true },
  SUCCESS: { label: 'Concluído', color: 'text-green-600', bgColor: 'bg-green-50', borderColor: 'border-green-200', icon: CheckCircle2, animate: false },
  ERROR: { label: 'Erro', color: 'text-[#730401]', bgColor: 'bg-[#730401]/5', borderColor: 'border-[#730401]/20', icon: XCircle, animate: false },
  ABORTED: { label: 'Abortada', color: 'text-orange-700', bgColor: 'bg-orange-50', borderColor: 'border-orange-200', icon: XCircle, animate: false },
};

// Card usado apos upload manual para acompanhar uma execucao especifica.
// Ele faz polling no detalhe da execucao; quando status=Crawling, o backend
// consulta Glue Crawler e atualiza o historico.
export default function ExecutionStatus({ executionId }: ExecutionStatusProps) {
  const [execution, setExecution] = useState<Execution | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchExecutionStatus();
    const interval = setInterval(fetchExecutionStatus, 3000);
    return () => clearInterval(interval);
  }, [executionId]);

  // Busca status atual e deixa o backend decidir se deve consultar Step Function
  // legado ou Glue Crawler manual.
  const fetchExecutionStatus = async () => {
    try {
      const response = await fetch(`/excel_ingestion/execution/${executionId}`);
      const data = await response.json();
      setExecution(data.execution);
      setIsLoading(false);
    } catch (err: any) {
      console.error('Error fetching execution status:', err);
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-8 h-8 text-[#730401] animate-spin" />
        </div>
      </div>
    );
  }

  if (!execution) return null;

  const config = statusConfig[execution.status] || statusConfig.RUNNING;
  const Icon = config.icon;
  const errorData = execution.errors ? JSON.parse(execution.errors) : null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-4">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Status da Execução</h3>

      <div className={`p-4 rounded-lg border ${config.bgColor} ${config.borderColor}`}>
        <div className="flex items-center space-x-3">
          <Icon className={`w-6 h-6 ${config.color} ${config.animate ? 'animate-spin' : ''}`} />
          <div>
            <p className={`font-medium ${config.color}`}>{config.label}</p>
            <p className="text-xs text-gray-400 mt-1">{execution.fileName}</p>
          </div>
        </div>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between items-center py-2 border-b border-gray-100">
          <span className="text-gray-400">Tabela:</span>
          <span className="text-gray-900 font-medium">{execution.tableName}</span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-gray-100">
          <span className="text-gray-400">Início:</span>
          <span className="text-gray-700">{new Date(execution.startTime).toLocaleString('pt-BR')}</span>
        </div>
        {execution.duration && (
          <div className="flex justify-between items-center py-2 border-b border-gray-100">
            <span className="text-gray-400">Duração:</span>
            <span className="text-gray-700">{execution.duration}s</span>
          </div>
        )}
      </div>

      {errorData && (
        <div className="mt-4 p-3 bg-[#730401]/5 border border-[#730401]/20 rounded-lg">
          <div className="flex items-start space-x-2">
            <AlertTriangle className="w-5 h-5 text-[#730401] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-[#730401]">{errorData.type}</p>
              <p className="text-xs text-[#730401] mt-1">{errorData.message}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
