export function newConversationFields(kind: 'dm' | 'group', data: FormData) {
  return kind === 'dm'
    ? { kind, userId: data.get('userId') }
    : { kind, name: data.get('name'), userIds: data.getAll('userIds') };
}
