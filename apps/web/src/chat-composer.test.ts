import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChatComposer } from './ChatComposer';

it('keeps the input enabled during delivery and puts the emoji trigger inside the composer form', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      body: 'Next message',
      onChange: () => {},
      onSend: () => {},
      reply: null,
      replyLoading: false,
      onCancelReply: () => {},
      disabled: false,
      sending: true,
      retrying: false,
      members: [],
      userId: 'me',
    }),
  );
  const input = html.match(/<textarea[^>]*>/)?.[0];
  expect(input).not.toContain('disabled');
  expect(input).toContain('rows="1"');
  const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
  expect(form).toContain('aria-label="Insert emoji"');
  expect(form).toContain('aria-label="Send message"');
  expect(html).not.toContain('😀');
});
