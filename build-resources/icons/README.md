# Ícone do Controle Run

Coloque nesta pasta a imagem original com o nome `app-icon.png`.

Recomendações:

- formato PNG;
- imagem quadrada;
- resolução de 1024 x 1024 pixels;
- fundo transparente, se possível;
- sem margens externas excessivas.

O arquivo PNG será usado como fonte para gerar o `app-icon.ico` do aplicativo e do instalador Windows.

Para gerar somente o arquivo `.ico`, execute:

```powershell
npm run icon:win
```

Ao executar `npm run package:win`, essa conversão acontece automaticamente antes do empacotamento.
