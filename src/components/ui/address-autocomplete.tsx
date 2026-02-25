/**
 * Address Autocomplete Component using SmartyStreets API
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { MapPin, Loader2 } from 'lucide-react';

export interface AddressSuggestion {
  streetLine: string;
  secondary: string;
  city: string;
  state: string;
  zipcode: string;
  entries: number;
  displayText: string;
}

export interface SelectedAddress {
  address1: string;
  address2: string;
  city: string;
  province: string;
  provinceCode: string;
  zip: string;
  country: string;
  countryCode: string;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect: (address: SelectedAddress) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = 'Start typing an address...',
  className,
  disabled,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [selectedForSecondary, setSelectedForSecondary] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSuggestions = useCallback(async (search: string, selected?: string) => {
    if (search.length < 3) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    try {
      const params = new URLSearchParams({ search });
      if (selected) {
        params.set('selected', selected);
      }
      const res = await fetch(`/api/address/autocomplete?${params}`);
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data.suggestions || []);
        setIsOpen(data.suggestions?.length > 0);
        setHighlightedIndex(-1);
      }
    } catch (err) {
      console.error('Error fetching address suggestions:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (value.length >= 3 && !selectedForSecondary) {
      debounceRef.current = setTimeout(() => {
        fetchSuggestions(value);
      }, 300);
    } else if (value.length < 3) {
      setSuggestions([]);
      setIsOpen(false);
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [value, fetchSuggestions, selectedForSecondary]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSelectedForSecondary(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
    setSelectedForSecondary(null);
  };

  const handleSelectSuggestion = (suggestion: AddressSuggestion) => {
    // If this suggestion has multiple entries (apartment/suite numbers), fetch secondary addresses
    if (suggestion.entries > 1) {
      const selected = `${suggestion.streetLine} ${suggestion.secondary} (${suggestion.entries}) ${suggestion.city} ${suggestion.state} ${suggestion.zipcode}`;
      setSelectedForSecondary(selected);
      onChange(suggestion.streetLine);
      fetchSuggestions(suggestion.streetLine, selected);
      return;
    }

    // Single entry - select the full address
    const address: SelectedAddress = {
      address1: suggestion.streetLine,
      address2: suggestion.secondary || '',
      city: suggestion.city,
      province: suggestion.state,
      provinceCode: suggestion.state,
      zip: suggestion.zipcode,
      country: 'United States',
      countryCode: 'US',
    };

    onChange(suggestion.streetLine);
    onSelect(address);
    setIsOpen(false);
    setSelectedForSecondary(null);
    setSuggestions([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || suggestions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
          handleSelectSuggestion(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        setIsOpen(false);
        setSelectedForSecondary(null);
        break;
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) {
              setIsOpen(true);
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'block w-full px-3 py-2 pr-10 border rounded-lg shadow-sm bg-white text-gray-900',
            'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
            'disabled:bg-gray-100 disabled:text-gray-700 disabled:cursor-not-allowed',
            'placeholder:text-gray-600',
            'border-gray-300',
            className
          )}
          autoComplete="off"
        />
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
          {isLoading ? (
            <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
          ) : (
            <MapPin className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </div>

      {isOpen && suggestions.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-auto">
          {selectedForSecondary && (
            <div className="px-3 py-2 text-xs text-gray-500 bg-gray-50 border-b">
              Select unit/apartment:
            </div>
          )}
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.streetLine}-${suggestion.secondary}-${suggestion.zipcode}-${index}`}
              type="button"
              onClick={() => handleSelectSuggestion(suggestion)}
              className={cn(
                'w-full px-3 py-2 text-left text-sm hover:bg-blue-50 focus:bg-blue-50 focus:outline-none',
                highlightedIndex === index && 'bg-blue-50',
                index !== suggestions.length - 1 && 'border-b border-gray-100'
              )}
            >
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-gray-900 truncate">
                    {suggestion.streetLine}
                    {suggestion.secondary && (
                      <span className="text-gray-600"> {suggestion.secondary}</span>
                    )}
                  </div>
                  <div className="text-gray-500 text-xs">
                    {suggestion.city}, {suggestion.state} {suggestion.zipcode}
                  </div>
                  {suggestion.entries > 1 && (
                    <div className="text-blue-600 text-xs mt-0.5">
                      {suggestion.entries} units available
                    </div>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
