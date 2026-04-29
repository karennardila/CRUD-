const { MongoClient, ObjectId } = require('mongodb');

const url = 'mongodb://localhost:27017';
const client = new MongoClient(url);
const dbName = 'test';

async function main() {
    try {
        await client.connect();
        console.log('Conectado exitosamente al servidor');

        const db = client.db(dbName);
        const usuarios = db.collection('usuarios');

        // Insertar
        const nuevoUsuario = {
            nombre: "Karen",
            email: "karen@email.com",
            edad: 19
        };

        const insertResult = await usuarios.insertOne(nuevoUsuario);
        console.log('Usuario creado con exito...');

        // Leer
        const listaUsuarios = await usuarios.find({}).toArray();
        console.log('Listar Usuarios');
        console.log(listaUsuarios);

        // Actualizar
        const updateResult = await usuarios.updateOne(
            { _id: insertResult.insertedId },
            { $set: { edad: 20 } }
        );
        console.log('Documento Actualizado');
        console.log(updateResult);

        // Borrar
        const deleteResult = await usuarios.deleteOne(
            { _id: insertResult.insertedId }
        );
        console.log('Documentos Eliminados');
        console.log(deleteResult);

    } catch (err) {
        console.log('Error', err);
    } finally {
        await client.close();
    }
}

main();