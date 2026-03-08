'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, Pencil } from 'lucide-react';

interface FilterRule {
  id: string;
  name: string;
  condition: string;
  value: string;
  enabled: boolean;
  createdAt: string;
}

const FILTER_CONDITION_LABELS: Record<string, string> = {
  SUBJECT_CONTAINS: 'Subject line contains',
  SUBJECT_STARTS_WITH: 'Subject line starts with',
  EMAIL_CONTAINS: 'Sender email address contains',
  EMAIL_DOMAIN: 'Sender email domain is',
};

export default function FiltersContent() {
  const queryClient = useQueryClient();
  const [showFilterForm, setShowFilterForm] = useState(false);
  const [newFilterName, setNewFilterName] = useState('');
  const [newFilterCondition, setNewFilterCondition] = useState('SUBJECT_CONTAINS');
  const [newFilterValue, setNewFilterValue] = useState('');
  const [applyFilterToExisting, setApplyFilterToExisting] = useState(false);
  const [editingFilterId, setEditingFilterId] = useState<string | null>(null);
  const [editFilterName, setEditFilterName] = useState('');
  const [editFilterCondition, setEditFilterCondition] = useState('SUBJECT_CONTAINS');
  const [editFilterValue, setEditFilterValue] = useState('');

  const { data: filterRules, isLoading } = useQuery<FilterRule[]>({
    queryKey: ['filter-rules'],
    queryFn: async () => {
      const res = await fetch('/api/filter-rules');
      if (!res.ok) throw new Error('Failed to fetch filter rules');
      return res.json();
    },
    staleTime: 30000,
  });

  const createFilterMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      condition: string;
      value: string;
      applyToExisting: boolean;
    }) => {
      const res = await fetch('/api/filter-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.details || err.error || 'Failed to create filter rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filter-rules'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      setShowFilterForm(false);
      setNewFilterName('');
      setNewFilterCondition('SUBJECT_CONTAINS');
      setNewFilterValue('');
      setApplyFilterToExisting(false);
    },
  });

  const toggleFilterMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await fetch(`/api/filter-rules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update filter rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filter-rules'] });
    },
  });

  const deleteFilterMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/filter-rules/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete filter rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filter-rules'] });
    },
  });

  const updateFilterMutation = useMutation({
    mutationFn: async (data: {
      id: string;
      name: string;
      condition: string;
      value: string;
    }) => {
      const res = await fetch(`/api/filter-rules/${data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          condition: data.condition,
          value: data.value,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update filter rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filter-rules'] });
      setEditingFilterId(null);
    },
  });

  const handleCreateFilter = () => {
    if (!newFilterName.trim() || !newFilterValue.trim()) return;
    createFilterMutation.mutate({
      name: newFilterName.trim(),
      condition: newFilterCondition,
      value: newFilterValue.trim(),
      applyToExisting: applyFilterToExisting,
    });
  };

  const handleDeleteFilter = (id: string, name: string) => {
    if (confirm(`Delete filter "${name}"?`)) {
      deleteFilterMutation.mutate(id);
    }
  };

  const handleEditFilter = (rule: FilterRule) => {
    setEditingFilterId(rule.id);
    setEditFilterName(rule.name);
    setEditFilterCondition(rule.condition);
    setEditFilterValue(rule.value);
  };

  const handleUpdateFilter = () => {
    if (!editingFilterId || !editFilterName.trim() || !editFilterValue.trim()) return;
    updateFilterMutation.mutate({
      id: editingFilterId,
      name: editFilterName.trim(),
      condition: editFilterCondition,
      value: editFilterValue.trim(),
    });
  };

  const handleCancelEditFilter = () => {
    setEditingFilterId(null);
    setEditFilterName('');
    setEditFilterCondition('SUBJECT_CONTAINS');
    setEditFilterValue('');
  };

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-12 bg-gray-200 rounded" />
        <div className="h-12 bg-gray-200 rounded" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-600">Automatically move matching emails to trash</p>
        {!showFilterForm && (
          <Button onClick={() => setShowFilterForm(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New Filter
          </Button>
        )}
      </div>

      {showFilterForm && (
        <div className="bg-white rounded-lg border p-6 mb-6">
          <h3 className="font-medium text-gray-900 mb-4">Create Filter Rule</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name</label>
              <Input
                value={newFilterName}
                onChange={(e) => setNewFilterName(e.target.value)}
                placeholder="e.g., Auto-trash spam"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Condition</label>
                <select
                  value={newFilterCondition}
                  onChange={(e) => {
                    setNewFilterCondition(e.target.value);
                    setNewFilterValue('');
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {Object.entries(FILTER_CONDITION_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Value to match</label>
                <Input
                  value={newFilterValue}
                  onChange={(e) => setNewFilterValue(e.target.value)}
                  placeholder="e.g., newsletter, @example.com"
                />
                {newFilterCondition === 'SUBJECT_CONTAINS' && (
                  <p className="mt-1 text-xs text-gray-500">
                    Tip: Use commas to require multiple words
                  </p>
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={applyFilterToExisting}
                onChange={(e) => setApplyFilterToExisting(e.target.checked)}
                className="rounded border-gray-300"
              />
              Apply to current inbox on save
            </label>
          </div>

          <div className="flex items-center gap-3 mt-6">
            <Button
              onClick={handleCreateFilter}
              loading={createFilterMutation.isPending}
              disabled={
                !newFilterName.trim() ||
                !newFilterValue.trim() ||
                createFilterMutation.isPending
              }
            >
              Create Filter
            </Button>
            <Button variant="secondary" onClick={() => setShowFilterForm(false)}>
              Cancel
            </Button>
            {createFilterMutation.error && (
              <span className="text-sm text-red-500">{createFilterMutation.error.message}</span>
            )}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {filterRules?.map((rule) => (
          <div
            key={rule.id}
            className={`bg-white rounded-lg border p-4 ${!rule.enabled ? 'opacity-60' : ''}`}
          >
            {editingFilterId === rule.id ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name</label>
                  <Input
                    value={editFilterName}
                    onChange={(e) => setEditFilterName(e.target.value)}
                    placeholder="Rule name"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Condition</label>
                    <select
                      value={editFilterCondition}
                      onChange={(e) => setEditFilterCondition(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {Object.entries(FILTER_CONDITION_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Value to match</label>
                    <Input
                      value={editFilterValue}
                      onChange={(e) => setEditFilterValue(e.target.value)}
                      placeholder="Value to match"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    onClick={handleUpdateFilter}
                    loading={updateFilterMutation.isPending}
                    disabled={
                      !editFilterName.trim() ||
                      !editFilterValue.trim() ||
                      updateFilterMutation.isPending
                    }
                  >
                    Save Changes
                  </Button>
                  <Button variant="secondary" onClick={handleCancelEditFilter}>
                    Cancel
                  </Button>
                  {updateFilterMutation.error && (
                    <span className="text-sm text-red-500">{updateFilterMutation.error.message}</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-rose-100 flex items-center justify-center">
                    <Trash2 className="w-5 h-5 text-rose-600" />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900">{rule.name}</h3>
                    <p className="text-sm text-gray-600">
                      When <span className="font-medium">{FILTER_CONDITION_LABELS[rule.condition]}</span>{' '}
                      <span className="text-blue-600 font-medium">{rule.value}</span> → move to trash
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => toggleFilterMutation.mutate({ id: rule.id, enabled: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                  <button
                    onClick={() => handleEditFilter(rule)}
                    className="p-2 text-gray-400 hover:text-blue-600"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDeleteFilter(rule.id, rule.name)}
                    className="p-2 text-gray-400 hover:text-red-600"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {filterRules?.length === 0 && (
          <div className="text-center py-12 bg-white rounded-lg border">
            <Trash2 className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">No filter rules created yet</p>
            <p className="text-sm text-gray-500">Create rules to auto-trash unwanted emails</p>
          </div>
        )}
      </div>
    </div>
  );
}
