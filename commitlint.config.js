export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'no-ai-coauthor': ({ raw }) => {
          const hasAiCoauthor = /Co-Authored-By:.*\b(Claude|GPT|Copilot|AI)\b/i.test(raw);
          return [
            !hasAiCoauthor,
            'Commits must not include AI Co-Authored-By trailers',
          ];
        },
      },
    },
  ],
  rules: {
    'no-ai-coauthor': [2, 'always'],
  },
};
