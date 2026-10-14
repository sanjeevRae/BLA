/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        page: '#F5F7FA',
        surface: '#FFFFFF',
        cream: '#F1F5F9',
        ink: '#0F172A',
        slate2: '#64748B',
        faint: '#94A3B8',
        brand: '#2563EB',
        accent: '#2563EB',
        accentbg: '#EFF6FF',
        green: '#16A34A',
        greenbg: '#E8F7EE',
        orange: '#EA580C',
        orangebg: '#FFF1E6',
        purple: '#7C3AED',
        purplebg: '#F1E9FD',
        red: '#DC2626',
        amber: '#F59E0B',
        line: '#E6EBF0',
        successbg: '#E8F7EE',
        successtx: '#16A34A',
        badgebg: '#F1F5F9',
        badgetx: '#64748B',
      },
      borderRadius: {
        sm: '2px',
        md: '3px',
        lg: '4px',
      },
      maxWidth: {
        content: '1450px',
      },
    },
  },
  plugins: [],
};
