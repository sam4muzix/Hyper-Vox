import React, { useState, useRef, useEffect } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
  icon?: React.ReactNode;
}

interface CustomSelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  options,
  value,
  onChange,
  label,
  placeholder = "Select option...",
  disabled = false,
  className = ""
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(o => o.value === value) || options[0];

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className={`relative w-full ${className}`}>
      {label && (
        <label className="block text-[11px] font-bold text-gray-300 uppercase tracking-wider mb-1.5">
          {label}
        </label>
      )}

      {/* Custom Selected Button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`w-full px-4 py-3 rounded-xl bg-black/40 border transition-all text-left flex items-center justify-between gap-3 text-xs font-semibold select-none ${
          isOpen
            ? 'border-emerald-400 bg-emerald-950/30 ring-2 ring-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.2)]'
            : 'border-white/10 hover:border-emerald-500/40 hover:bg-white/[0.04]'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer text-white'}`}
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {selectedOption?.icon && (
            <span className="text-emerald-400 flex-shrink-0">{selectedOption.icon}</span>
          )}
          <div className="truncate">
            <span className="truncate block font-semibold text-white">
              {selectedOption ? selectedOption.label : placeholder}
            </span>
            {selectedOption?.sublabel && (
              <span className="text-[10px] text-gray-400 block truncate font-normal mt-0.5">
                {selectedOption.sublabel}
              </span>
            )}
          </div>
        </div>

        <svg
          className={`w-4 h-4 text-emerald-400 flex-shrink-0 transition-transform duration-300 ${
            isOpen ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Floating Emerald Glass Dropdown List */}
      {isOpen && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 bg-[#081810]/95 border border-emerald-500/30 rounded-2xl p-1.5 shadow-[0_15px_40px_rgba(0,0,0,0.9)] backdrop-blur-3xl max-h-60 overflow-y-auto custom-scrollbar animate-fade-in space-y-1">
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
                className={`w-full px-3.5 py-2.5 rounded-xl text-left text-xs font-semibold transition-all flex items-center justify-between gap-3 select-none ${
                  isSelected
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-bold shadow-sm'
                    : 'text-gray-300 hover:text-white hover:bg-emerald-500/10 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {opt.icon && (
                    <span className={isSelected ? 'text-emerald-400' : 'text-gray-400'}>
                      {opt.icon}
                    </span>
                  )}
                  <div className="truncate">
                    <span className="block truncate">{opt.label}</span>
                    {opt.sublabel && (
                      <span className="text-[10px] text-gray-400 block truncate font-normal">
                        {opt.sublabel}
                      </span>
                    )}
                  </div>
                </div>

                {isSelected && (
                  <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
