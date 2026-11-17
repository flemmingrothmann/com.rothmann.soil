'use strict';

// HA categories are scoped to their UI list; helpers use the plural scope "helpers".
class HomeAssistantCategories {
  constructor({ ws, name, undo }) {
    Object.assign(this, { ws, name, undo });
    this.ids = new Map();
  }

  async category(scope) {
    if (this.ids.has(scope)) return this.ids.get(scope);
    const find = (entries) => entries.find((entry) => entry.name.toLocaleLowerCase('da') === this.name.toLocaleLowerCase('da'));
    let entry = find(await this.ws('config/category_registry/list', { scope }));
    if (!entry) {
      try {
        entry = await this.ws('config/category_registry/create', { scope, name: this.name, icon: 'mdi:watering-can' });
      } catch (error) {
        // A user/another setup operation can create the shared category concurrently.
        entry = find(await this.ws('config/category_registry/list', { scope }));
        if (!entry) throw error;
      }
    }
    this.ids.set(scope, entry.category_id);
    return entry.category_id;
  }

  async assign(entityId, scope) {
    const entity = await this.ws('config/entity_registry/get', { entity_id: entityId });
    const previous = entity.categories?.[scope] || null;
    // The user owns subsequent category choices. Only fill an unassigned category.
    if (previous) return;
    const categoryId = await this.category(scope);
    this.undo?.push(async () => {
      const current = (await this.ws('config/entity_registry/list')).find((entry) => entry.entity_id === entityId);
      if (current?.categories?.[scope] !== categoryId) return;
      await this.ws('config/entity_registry/update', { entity_id: entityId, categories: { [scope]: previous } });
    });
    await this.ws('config/entity_registry/update', { entity_id: entityId, categories: { [scope]: categoryId } });
  }
}

module.exports = { HomeAssistantCategories };
