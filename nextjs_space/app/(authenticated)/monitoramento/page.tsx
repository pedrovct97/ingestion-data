'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Filter,
  Loader2,
  Send,
  TrendingUp,
  Upload,
  UserRound,
  XCircle,
} from 'lucide-react';

interface Metrics {
  totalToday: number;
  successToday: number;
  errorToday: number;
  runningCount: number;
  avgDuration: number;
  successRate: number;
}

interface Execution {
  id: string;
  tableName: string;
  fileName: string;
  fileSize?: number;
  status: string;
  sourceType?: string;
  startTime: string;
  endTime?: string;
  duration?: number;
  errors?: string;
  user?: {
    id: string;
    name?: string | null;
    email: string;
  } | null;
}

const sourceConfig: any = {
  admin: { label: 'auditoria', icon: UserRound, classes: 'bg-slate-50 text-slate-700' },
  api: { label: 'api', icon: Send, classes: 'bg-purple-50 text-purple-600' },
  calendar: { label: 'calendário', icon: CalendarDays, classes: 'bg-emerald-50 text-emerald-700' },
  download: { label: 'download', icon: Download, classes: 'bg-indigo-50 text-indigo-700' },
  file: { label: 'arquivo', icon: Upload, classes: 'bg-sky-50 text-sky-600' },
};

const statusStyle: Record<string, { label: string; color: string; bg: string; icon: typeof Activity }> = {
  SUCCESS: { label: 'Sucesso', color: 'text-green-600', bg: 'bg-green-50', icon: CheckCircle2 },
  ERROR: { label: 'Erro', color: 'text-[#730401]', bg: 'bg-[#730401]/5', icon: XCircle },
  ABORTED: { label: 'Abortada', color: 'text-orange-700', bg: 'bg-orange-50', icon: XCircle },
  RUNNING: { label: 'Em execução', color: 'text-amber-600', bg: 'bg-amber-50', icon: Activity },
  CRAWLING: { label: 'Catalogando', color: 'text-amber-600', bg: 'bg-amber-50', icon: Activity },
  UPLOADING: { label: 'Upload', color: 'text-blue-600', bg: 'bg-blue-50', icon: Loader2 },
  VALIDATING: { label: 'Validando', color: 'text-blue-600', bg: 'bg-blue-50', icon: Loader2 },
};

export default function MonitoramentoPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceTypeFilter, setSourceTypeFilter] = useState('all');
  const [executionDateFilter, setExecutionDateFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchExecutions();
  }, [statusFilter, sourceTypeFilter, executionDateFilter, userFilter]);

  const fetchMetrics = async () => {
    try {
      const response = await fetch('/excel_ingestion/metrics');
      const data = await response.json();
      setMetrics(data.metrics);
    } catch (err: any) {
      console.error('Error fetching metrics:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchExecutions = async () => {
    setIsHistoryLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (sourceTypeFilter !== 'all') params.append('sourceType', sourceTypeFilter);
      if (executionDateFilter) params.append('executionDate', executionDateFilter);
      if (userFilter.trim()) params.append('user', userFilter.trim());
      params.append('limit', '50');
      const response = await fetch(`/excel_ingestion/executions?${params.toString()}`);
      const data = await response.json();
      setExecutions(data.executions || []);
    } catch (err: any) {
      console.error('Error fetching executions:', err);
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return 'N/A';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return 'N/A';
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  const formatUser = (user?: Execution['user']) => {
    if (!user) return 'Sem Usuário';
    return user.name || user.email;
  };

  const formatTableName = (execution: Execution) => {
    if (execution.sourceType === 'calendar') return 'Calendário de execução';
    if (execution.sourceType === 'download') return 'Download de extração';
    return execution.tableName;
  };

  const parseErrorData = (errors?: string) => {
    if (!errors) return null;
    try {
      const parsed = JSON.parse(errors);
      return {
        type: parsed.type || 'Erro',
        message: parsed.message || errors,
        details: parsed.details,
      };
    } catch {
      return { type: 'Erro', message: errors, details: null };
    }
  };

  const formatErrorDetails = (details: any) => {
    if (!details) return '';
    if (typeof details === 'string') return details;
    return JSON.stringify(details, null, 2);
  };

  const metricCards = [
    { title: 'Execuções Hoje', value: metrics?.totalToday || 0, icon: Activity, color: 'text-blue-600', bgColor: 'bg-blue-50', borderColor: 'border-blue-100' },
    { title: 'Taxa de Sucesso', value: `${metrics?.successRate || 0}%`, icon: TrendingUp, color: 'text-green-600', bgColor: 'bg-green-50', borderColor: 'border-green-100' },
    { title: 'Duração Média', value: formatDuration(metrics?.avgDuration), icon: Clock, color: 'text-purple-600', bgColor: 'bg-purple-50', borderColor: 'border-purple-100' },
    { title: 'Em Execução', value: metrics?.runningCount || 0, icon: Activity, color: 'text-amber-600', bgColor: 'bg-amber-50', borderColor: 'border-amber-100' },
  ];

  const renderExecutionRow = (execution: Execution) => {
    const style = statusStyle[execution.status] || statusStyle.RUNNING;
    const StatusIcon = style.icon;
    const source = sourceConfig[execution.sourceType || 'file'] || sourceConfig.file;
    const SourceIcon = source.icon;
    const isExpanded = expandedId === execution.id;
    const errorData = parseErrorData(execution.errors);

    return (
      <div key={execution.id} className="hover:bg-gray-50/50 transition-colors">
        <div className="p-4 cursor-pointer" onClick={() => setExpandedId(isExpanded ? null : execution.id)}>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center space-x-4 flex-1 min-w-0">
              <StatusIcon className={`w-5 h-5 ${style.color} flex-shrink-0 ${['RUNNING', 'CRAWLING', 'UPLOADING', 'VALIDATING'].includes(execution.status) ? 'animate-spin' : ''}`} />
              <div className="flex-1 min-w-0">
                <p className="text-gray-900 font-medium truncate">{execution.fileName}</p>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-gray-400">{formatTableName(execution)}</p>
                  {execution.sourceType && (
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${source.classes}`}>
                      <SourceIcon className="w-2.5 h-2.5" />
                      {source.label}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
                  <UserRound className="w-3.5 h-3.5" />
                  <span className="truncate">{formatUser(execution.user)}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center space-x-6">
              <div className="hidden md:block text-sm">
                <p className="text-gray-400">Início</p>
                <p className="text-gray-700">
                  {new Date(execution.startTime).toLocaleString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
              <div className="hidden md:block text-sm">
                <p className="text-gray-400">Duração</p>
                <p className="text-gray-700">{formatDuration(execution.duration)}</p>
              </div>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${style.color} ${style.bg}`}>
                {style.label}
              </span>
              {isExpanded ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
            </div>
          </div>
        </div>

        {isExpanded && (
          <div className="px-4 pb-4 border-t border-gray-100 bg-gray-50/50">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 pt-4">
              <div>
                <p className="text-xs text-gray-400 font-medium">Tamanho</p>
                <p className="text-sm text-gray-700 mt-1">{formatFileSize(execution.fileSize)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Início</p>
                <p className="text-sm text-gray-700 mt-1">{new Date(execution.startTime).toLocaleString('pt-BR')}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Conclusão</p>
                <p className="text-sm text-gray-700 mt-1">
                  {execution.endTime ? new Date(execution.endTime).toLocaleString('pt-BR') : 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">Usuário</p>
                <p className="text-sm text-gray-700 mt-1 truncate">{formatUser(execution.user)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 font-medium">ID</p>
                <p className="text-sm text-gray-700 mt-1 font-mono truncate">{execution.id.slice(0, 8)}</p>
              </div>
            </div>
            {errorData && (
              <div className="mt-4 p-3 bg-[#730401]/5 border border-[#730401]/20 rounded-lg">
                <p className="text-sm font-medium text-[#730401] mb-1">{errorData.type}</p>
                <p className="text-xs text-[#730401]">{errorData.message}</p>
                {errorData.details && (
                  <pre className="text-xs text-[#730401] mt-2 whitespace-pre-wrap break-words">
                    {formatErrorDetails(errorData.details)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-[#730401] mb-1">Monitoramento</h1>
        <p className="text-gray-500">Visão geral, histórico e rastreio das execuções</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {metricCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.title} className={`bg-white rounded-xl shadow-sm border ${card.borderColor} p-6 hover:shadow-md transition-all`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-gray-500">{card.title}</h3>
                <div className={`w-10 h-10 rounded-lg ${card.bgColor} flex items-center justify-center`}>
                  <Icon className={`w-5 h-5 ${card.color}`} />
                </div>
              </div>
              <p className={`text-3xl font-bold ${card.color}`}>{isLoading ? '-' : card.value}</p>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-white rounded-xl shadow-sm border border-green-100 p-6">
          <div className="flex items-center space-x-3 mb-4">
            <CheckCircle2 className="w-6 h-6 text-green-600" />
            <h3 className="text-lg font-semibold text-gray-900">Execuções Bem-Sucedidas</h3>
          </div>
          <p className="text-4xl font-bold text-green-600">{metrics?.successToday || 0}</p>
          <p className="text-sm text-gray-400 mt-2">Hoje</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-[#730401]/15 p-6">
          <div className="flex items-center space-x-3 mb-4">
            <XCircle className="w-6 h-6 text-[#730401]" />
            <h3 className="text-lg font-semibold text-gray-900">Execuções com Erro</h3>
          </div>
          <p className="text-4xl font-bold text-[#730401]">{metrics?.errorToday || 0}</p>
          <p className="text-sm text-gray-400 mt-2">Hoje</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center space-x-3 mb-4">
          <Filter className="w-5 h-5 text-[#730401]" />
          <h3 className="text-lg font-semibold text-gray-900">Histórico de Execuções</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Data de execução</label>
            <input
              type="date"
              value={executionDateFilter}
              onChange={(event) => setExecutionDateFilter(event.target.value)}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#730401]/30 focus:border-[#730401]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Tipo de execução</label>
            <select
              value={sourceTypeFilter}
              onChange={(event) => setSourceTypeFilter(event.target.value)}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#730401]/30 focus:border-[#730401]"
            >
              <option value="all">Todos</option>
              <option value="download">Download</option>
              <option value="api">API</option>
              <option value="admin">Auditoria</option>
              <option value="file">Ingestão manual</option>
              <option value="calendar">Calendário</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Usuário</label>
            <input
              type="text"
              value={userFilter}
              onChange={(event) => setUserFilter(event.target.value)}
              placeholder="Nome ou e-mail"
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#730401]/30 focus:border-[#730401]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Status</label>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#730401]/30 focus:border-[#730401]"
            >
              <option value="all">Todos</option>
              <option value="SUCCESS">Sucesso</option>
              <option value="ERROR">Erro</option>
              <option value="ABORTED">Abortada</option>
              <option value="RUNNING">Em execução</option>
              <option value="CRAWLING">Catalogando</option>
              <option value="UPLOADING">Upload</option>
              <option value="VALIDATING">Validando</option>
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {isHistoryLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-[#730401] animate-spin" />
          </div>
        ) : executions.length === 0 ? (
          <div className="text-center py-12">
            <FileSpreadsheet className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-400">Nenhuma execução encontrada</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {executions.map((execution) => renderExecutionRow(execution))}
          </div>
        )}
      </div>

      <div className="bg-[#730401]/5 rounded-xl shadow-sm border border-[#730401]/15 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Logs Detalhados no CloudWatch</h3>
            <p className="text-sm text-gray-500">Visualize logs detalhados e métricas avançadas no AWS CloudWatch</p>
          </div>
          <a
            href="https://console.aws.amazon.com/cloudwatch/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center space-x-2 px-4 py-2 bg-[#730401] text-white rounded-lg hover:bg-[#5f0301] transition-all shadow-sm"
          >
            <span className="text-sm font-medium">Abrir CloudWatch</span>
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  );
}

