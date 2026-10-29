import { createTheme, PasswordInput, type MantineColorsTuple } from '@mantine/core';

const highland: MantineColorsTuple = ['#e6f7f5', '#cdeee9', '#9ddcd3', '#69c9bb', '#40b9a8', '#27af9c', '#15a995', '#039381', '#008373', '#007163'];

// The single visual system. No web fonts are shipped: the system font stack loads instantly and needs no licence.
export const theme = createTheme({
  colors: { highland },
  primaryColor: 'highland',
  primaryShade: { light: 7, dark: 5 },
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  defaultRadius: 'md',
  headings: { fontWeight: '650' },
  components: {
    // size md keeps every touch target at least 42 px tall.
    Button: { defaultProps: { size: 'md' } },
    TextInput: { defaultProps: { size: 'md' } },
    // The show/hide eye is a button too, so it fills the field's height instead of Mantine's 28 px.
    PasswordInput: PasswordInput.extend({ defaultProps: { size: 'md' }, styles: { visibilityToggle: { width: 40, height: 40 } } }),
    Textarea: { defaultProps: { size: 'md' } },
    Select: { defaultProps: { size: 'md' } },
  },
});
