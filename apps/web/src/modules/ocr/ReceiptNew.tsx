import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Container, Stack } from '@mantine/core';
import { requestReading } from '../../api.js';
import { ErrorNotice, FileDropzone, PageHeader } from '../../ui/index.js';
import { prepareReceiptImage } from './prepareImage.js';

/** Example page (client apps keep, change or remove it): take or choose a receipt, then check what was read. */
export function ReceiptNew() {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  return (
    <Container size="md" p={0}>
      <PageHeader title="Read a receipt" description="Take a photo of the receipt or choose a file. You check the details before anything is saved." />
      <Stack gap="md" maw={720}>
        <ErrorNotice error={error} />
        <FileDropzone
          prepare={prepareReceiptImage}
          onUploaded={(file) => {
            setError(null);
            // A fresh upload for every receipt: a file already attached to something else can't be read (409).
            requestReading(file.id).then((r) => { void navigate(`/receipts/${r.id}`); }, setError);
          }}
          onRemoved={() => { setError(null); }}
        />
      </Stack>
    </Container>
  );
}
