'use client';

/**
 * Assignment Rules page - create and manage auto-assignment rules
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, UserCheck, X, Pencil } from 'lucide-react';

interface User {
  id: string;
  name: string;
  email: string;
}

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface AssignmentRule {
  id: string;
  name: string;
  condition: string;
  value: string;
  priority: number;
  enabled: boolean;
  assignTo: User;
}

interface FilterRule {
  id: string;
  name: string;
  condition: string;
  value: string;
  enabled: boolean;
  createdAt: string;
}

const CONDITION_LABELS: Record<string, string> = {
  SUBJECT_CONTAINS: 'Subject line contains',
  SUBJECT_STARTS_WITH: 'Subject line starts with',
  EMAIL_CONTAINS: 'Sender email address contains',
  EMAIL_DOMAIN: 'Sender email domain is',
  BODY_CONTAINS: 'Message body contains',
  WEEKDAY: 'Day of week is',
  TIME_RANGE: 'Time is between',
  HAS_TAG: 'Has tag',
};

const FILTER_CONDITION_LABELS: Record<string, string> = {
  SUBJECT_CONTAINS: 'Subject line contains',
  SUBJECT_STARTS_WITH: 'Subject line starts with',
  EMAIL_CONTAINS: 'Sender email address contains',
  EMAIL_DOMAIN: 'Sender email domain is',
};

const WEEKDAYS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

// Format value for display based on condition type
function formatRuleValue(condition: string, value: string): string {
  if (condition === 'WEEKDAY') {
    const dayNumbers = value.split(',').map((d) => d.trim());
    const dayNames = dayNumbers.map((d) => WEEKDAYS.find((w) => w.value === d)?.label || d);
    return dayNames.join(', ');
  }
  if (condition === 'TIME_RANGE') {
    const [start, end] = value.split('-');
    return `${start} - ${end}`;
  }
  return value;
}

export default function RulesPage() {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleCondition, setNewRuleCondition] = useState('SUBJECT_CONTAINS');
  const [newRuleValue, setNewRuleValue] = useState('');
  const [newRuleAssignTo, setNewRuleAssignTo] = useState('');
  const [newRulePriority, setNewRulePriority] = useState(0);
  const [showFilterForm, setShowFilterForm] = useState(false);
  const [newFilterName, setNewFilterName] = useState('');
  const [newFilterCondition, setNewFilterCondition] = useState('SUBJECT_CONTAINS');
  const [newFilterValue, setNewFilterValue] = useState('');
  const [applyFilterToExisting, setApplyFilterToExisting] = useState(false);
  const [editingFilterId, setEditingFilterId] = useState<string | null>(null);
  const [editFilterName, setEditFilterName] = useState('');
  const [editFilterCondition, setEditFilterCondition] = useState('SUBJECT_CONTAINS');
  const [editFilterValue, setEditFilterValue] = useState('');

  const { data: rules, isLoading } = useQuery<AssignmentRule[]>({
    queryKey: ['assignment-rules'],
    queryFn: async () => {
      const res = await fetch('/api/assignment-rules');
      if (!res.ok) throw new Error('Failed to fetch rules');
      return res.json();
    },
    staleTime: 30000,
  });

  const { data: users } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/admin/users');
      if (!res.ok) throw new Error('Failed to fetch users');
      const data = await res.json();
      return data.users || [];
    },
    staleTime: 60000,
  });

  const { data: tags } = useQuery<Tag[]>({
    queryKey: ['tags'],
    queryFn: async () => {
      const res = await fetch('/api/tags');
      if (!res.ok) throw new Error('Failed to fetch tags');
      return res.json();
    },
    staleTime: 60000,
  });

  const { data: filterRules } = useQuery<FilterRule[]>({
    queryKey: ['filter-rules'],
    queryFn: async () => {
      const res = await fetch('/api/filter-rules');
      if (!res.ok) throw new Error('Failed to fetch filter rules');
      return res.json();
    },
    staleTime: 30000,
  });

  const createMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      condition: string;
      value: string;
      assignToId: string;
      priority: number;
    }) => {
      const res = await fetch('/api/assignment-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignment-rules'] });
      setShowCreateForm(false);
      setNewRuleName('');
      setNewRuleCondition('SUBJECT_CONTAINS');
      setNewRuleValue('');
      setNewRuleAssignTo('');
      setNewRulePriority(0);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await fetch(`/api/assignment-rules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignment-rules'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/assignment-rules/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete rule');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assignment-rules'] });
    },
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
      const res = await fetch(`/api/filter-rules/${id}`, {
        method: 'DELETE',
      });
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

  const handleCreate = () => {
    if (!newRuleName.trim() || !newRuleValue.trim() || !newRuleAssignTo) return;
    createMutation.mutate({
      name: newRuleName.trim(),
      condition: newRuleCondition,
      value: newRuleValue.trim(),
      assignToId: newRuleAssignTo,
      priority: newRulePriority,
    });
  };

  const handleDelete = (id: string, name: string) => {
    if (confirm(`Delete rule "${name}"?`)) {
      deleteMutation.mutate(id);
    }
  };

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
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4" />
          <div className="h-12 bg-gray-200 rounded" />
          <div className="h-12 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Assignment Rules</h1>
          <p className="text-sm text-gray-900">
            Automatically assign incoming tickets to agents based on conditions
          </p>
        </div>
        {!showCreateForm && (
          <Button onClick={() => setShowCreateForm(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New Rule
          </Button>
        )}
      </div>

      {/* Create form */}
      {showCreateForm && (
        <div className="bg-white rounded-lg border p-6 mb-6">
          <h3 className="font-medium text-gray-900 mb-4">Create Assignment Rule</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1">
                Rule Name
              </label>
              <Input
                value={newRuleName}
                onChange={(e) => setNewRuleName(e.target.value)}
                placeholder="e.g., Shipping inquiries to John"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1">
                  Condition
                </label>
                <select
                  value={newRuleCondition}
                  onChange={(e) => {
                    setNewRuleCondition(e.target.value);
                    setNewRuleValue(''); // Reset value when condition changes
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {Object.entries(CONDITION_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1">
                  {newRuleCondition === 'WEEKDAY' ? 'Select Days' :
                   newRuleCondition === 'TIME_RANGE' ? 'Time Range' :
                   newRuleCondition === 'HAS_TAG' ? 'Select Tag' : 'Value to Match'}
                </label>
                {newRuleCondition === 'WEEKDAY' ? (
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAYS.map((day) => (
                      <label key={day.value} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={newRuleValue.split(',').includes(day.value)}
                          onChange={(e) => {
                            const days = newRuleValue ? newRuleValue.split(',').filter(Boolean) : [];
                            if (e.target.checked) {
                              days.push(day.value);
                            } else {
                              const idx = days.indexOf(day.value);
                              if (idx > -1) days.splice(idx, 1);
                            }
                            setNewRuleValue(days.join(','));
                          }}
                          className="rounded border-gray-300"
                        />
                        <span className="text-sm text-gray-900">{day.label}</span>
                      </label>
                    ))}
                  </div>
                ) : newRuleCondition === 'TIME_RANGE' ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      value={newRuleValue.split('-')[0] || ''}
                      onChange={(e) => {
                        const end = newRuleValue.split('-')[1] || '';
                        setNewRuleValue(`${e.target.value}-${end}`);
                      }}
                      className="w-32"
                    />
                    <span className="text-gray-900">to</span>
                    <Input
                      type="time"
                      value={newRuleValue.split('-')[1] || ''}
                      onChange={(e) => {
                        const start = newRuleValue.split('-')[0] || '';
                        setNewRuleValue(`${start}-${e.target.value}`);
                      }}
                      className="w-32"
                    />
                  </div>
                ) : newRuleCondition === 'HAS_TAG' ? (
                  <select
                    value={newRuleValue}
                    onChange={(e) => setNewRuleValue(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select a tag...</option>
                    {tags?.map((tag) => (
                      <option key={tag.id} value={tag.name}>
                        {tag.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={newRuleValue}
                    onChange={(e) => setNewRuleValue(e.target.value)}
                    placeholder="e.g., shipping, tracking"
                  />
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1">
                  Assign To
                </label>
                <select
                  value={newRuleAssignTo}
                  onChange={(e) => setNewRuleAssignTo(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select an agent...</option>
                  {users?.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name} ({user.email})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1">
                  Priority (higher = checked first)
                </label>
                <Input
                  type="number"
                  value={newRulePriority}
                  onChange={(e) => setNewRulePriority(parseInt(e.target.value) || 0)}
                  min={0}
                  max={100}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 mt-6">
            <Button
              onClick={handleCreate}
              loading={createMutation.isPending}
              disabled={
                !newRuleName.trim() ||
                !newRuleValue.trim() ||
                !newRuleAssignTo ||
                createMutation.isPending
              }
            >
              Create Rule
            </Button>
            <Button variant="secondary" onClick={() => setShowCreateForm(false)}>
              Cancel
            </Button>
            {createMutation.error && (
              <span className="text-sm text-red-500">{createMutation.error.message}</span>
            )}
          </div>
        </div>
      )}

      {/* Rules list */}
      <div className="space-y-3">
        {rules?.map((rule) => (
          <div
            key={rule.id}
            className={`bg-white rounded-lg border p-4 ${
              !rule.enabled ? 'opacity-60' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                  <UserCheck className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">{rule.name}</h3>
                  <p className="text-sm text-gray-900">
                    When <span className="font-medium text-gray-900">{CONDITION_LABELS[rule.condition]}</span>{' '}
                    <span className="text-blue-600 font-medium">{formatRuleValue(rule.condition, rule.value)}</span> → assign to{' '}
                    <span className="font-medium text-gray-900">{rule.assignTo.name}</span>
                  </p>
                  <p className="text-xs text-gray-900 mt-1">Priority: {rule.priority}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) =>
                      toggleMutation.mutate({ id: rule.id, enabled: e.target.checked })
                    }
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
                <button
                  onClick={() => handleDelete(rule.id, rule.name)}
                  className="p-2 text-gray-500 hover:text-red-600"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}

        {rules?.length === 0 && (
          <div className="text-center py-12 bg-white rounded-lg border">
            <UserCheck className="w-12 h-12 text-gray-500 mx-auto mb-4" />
            <p className="text-gray-900">No assignment rules created yet</p>
            <p className="text-sm text-gray-900">
              Create rules to automatically assign tickets to agents
            </p>
          </div>
        )}
      </div>

      <div className="mt-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Inbox Filters</h2>
            <p className="text-sm text-gray-900">
              Automatically move matching emails to trash
            </p>
          </div>
          {!showFilterForm && (
            <Button onClick={() => setShowFilterForm(true)}>
              <Plus className="w-4 h-4 mr-2" />
              New Filter
            </Button>
          )}
        </div>

        {showFilterForm && (
          <div className="bg-white rounded-lg border p-6 mb-6">
            <h3 className="font-medium text-gray-900 mb-4">
              Create Filter Rule
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-1">
                  Rule Name
                </label>
                <Input
                  value={newFilterName}
                  onChange={(e) => setNewFilterName(e.target.value)}
                  placeholder="e.g., Auto-trash spam"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-900 mb-1">
                    Condition
                  </label>
                  <select
                    value={newFilterCondition}
                    onChange={(e) => {
                      setNewFilterCondition(e.target.value);
                      setNewFilterValue('');
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {Object.entries(FILTER_CONDITION_LABELS).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      )
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900 mb-1">
                    Value to match
                  </label>
                  <Input
                    value={newFilterValue}
                    onChange={(e) => setNewFilterValue(e.target.value)}
                    placeholder="e.g., newsletter, @example.com"
                  />
                  {newFilterCondition === 'SUBJECT_CONTAINS' && (
                    <p className="mt-1 text-xs text-gray-500">
                      Tip: Use commas to require multiple words, e.g. "unsubscribe, newsletter" matches only if both are present
                    </p>
                  )}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-900">
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
              <Button
                variant="secondary"
                onClick={() => setShowFilterForm(false)}
              >
                Cancel
              </Button>
              {createFilterMutation.error && (
                <span className="text-sm text-red-500">
                  {createFilterMutation.error.message}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="space-y-3">
          {filterRules?.map((rule) => (
            <div
              key={rule.id}
              className={`bg-white rounded-lg border p-4 ${
                !rule.enabled ? 'opacity-60' : ''
              }`}
            >
              {editingFilterId === rule.id ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-1">
                      Rule Name
                    </label>
                    <Input
                      value={editFilterName}
                      onChange={(e) => setEditFilterName(e.target.value)}
                      placeholder="Rule name"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-900 mb-1">
                        Condition
                      </label>
                      <select
                        value={editFilterCondition}
                        onChange={(e) => setEditFilterCondition(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {Object.entries(FILTER_CONDITION_LABELS).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-900 mb-1">
                        Value to match
                      </label>
                      <Input
                        value={editFilterValue}
                        onChange={(e) => setEditFilterValue(e.target.value)}
                        placeholder="Value to match"
                      />
                      {editFilterCondition === 'SUBJECT_CONTAINS' && (
                        <p className="mt-1 text-xs text-gray-500">
                          Tip: Use commas to require multiple words
                        </p>
                      )}
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
                      <span className="text-sm text-red-500">
                        {updateFilterMutation.error.message}
                      </span>
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
                      <p className="text-sm text-gray-900">
                        When{' '}
                        <span className="font-medium text-gray-900">
                          {FILTER_CONDITION_LABELS[rule.condition]}
                        </span>{' '}
                        <span className="text-blue-600 font-medium">{rule.value}</span> → move
                        to trash
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) =>
                          toggleFilterMutation.mutate({
                            id: rule.id,
                            enabled: e.target.checked,
                          })
                        }
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                    <button
                      onClick={() => handleEditFilter(rule)}
                      className="p-2 text-gray-500 hover:text-blue-600"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteFilter(rule.id, rule.name)}
                      className="p-2 text-gray-500 hover:text-red-600"
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
              <Trash2 className="w-12 h-12 text-gray-500 mx-auto mb-4" />
              <p className="text-gray-900">No filter rules created yet</p>
              <p className="text-sm text-gray-900">
                Create rules to auto-trash unwanted emails
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
