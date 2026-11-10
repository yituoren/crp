// A Material checkbox with its label: <check-box checked="{{x}}" disabled bind:change="..." label="..." />
Component({
  options: { styleIsolation: 'apply-shared', multipleSlots: true },
  properties: { checked: { type: Boolean, value: false }, disabled: { type: Boolean, value: false }, label: { type: String, value: '' } },
  methods: {
    toggle() { if (!this.data.disabled) this.triggerEvent('change', { checked: !this.data.checked }); },
  },
});
