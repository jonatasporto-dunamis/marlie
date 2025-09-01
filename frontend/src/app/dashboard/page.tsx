'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type AdminData = {
  status: string;
  name: string;
  endpoints: string[];
};

export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [states, setStates] = useState<ConversationState[]>([]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }

    const fetchData = async () => {
      try {
        const response = await axios.get('http://localhost:3000/admin', {
          headers: { Authorization: `Bearer ${token}` }
        });
        setData(response.data);
      } catch (error) {
        toast({ title: 'Erro', description: 'Falha ao carregar dados.', variant: 'destructive' });
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          localStorage.removeItem('token');
          router.push('/login');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [router, toast]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    router.push('/login');
  };

  if (loading) return <div className="flex min-h-screen items-center justify-center">Carregando...</div>;

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Dashboard Administrativo - Marliê</h1>
        <Button onClick={handleLogout} variant="outline">Sair</Button>
      </div>
      {data ? (
        <Card>
          <CardHeader>
            <CardTitle>{data.name}</CardTitle>
            <CardDescription>Status: {data.status}</CardDescription>
          </CardHeader>
          <CardContent>
            <h3 className="font-semibold mb-2">Endpoints Disponíveis:</h3>
            <ul className="list-disc pl-5">
              {data.endpoints.map((endpoint, index) => (
                <li key={index}>{endpoint}</li>
              ))}
            </ul>
          </CardContent>
          <Card>
            <CardHeader>
              <CardTitle>Estados de Conversa</CardTitle>
              <CardDescription>Lista de estados de conversa por telefone.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {states.map((state, index) => (
                    <TableRow key={index}>
                      <TableCell>{state.phone}</TableCell>
                      <TableCell>{JSON.stringify(state.state)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </Card>
      ) : (
        <p>Nenhum dado disponível.</p>
      )}
    </div>
  );
}

type ConversationState = {
  phone: string;
  state: any;
};

// Fetch conversation states
try {
  const statesResponse = await axios.get('http://localhost:3000/admin/states', {
    headers: { Authorization: `Bearer ${token}` }
  });
  setStates(statesResponse.data);
} catch (error) {
  toast({ title: 'Erro', description: 'Falha ao carregar estados de conversa.', variant: 'destructive' });
}