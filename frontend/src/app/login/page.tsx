'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

type LoginForm = {
  username: string;
  password: string;
};

export default function LoginPage() {
  const { register, handleSubmit, formState: { errors } } = useForm<LoginForm>();
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const onSubmit = async (data: LoginForm) => {
    setLoading(true);
    try {
      const response = await axios.post('http://localhost:3000/admin/login', data); // Ajustar para URL da API
      const { token } = response.data;
      localStorage.setItem('token', token);
      toast({ title: 'Login bem-sucedido', description: 'Redirecionando para o dashboard.' });
      router.push('/dashboard');
    } catch (_error) {
      toast({ title: 'Erro de login', description: 'Credenciais inválidas.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <Card className="w-[350px]">
        <CardHeader>
          <CardTitle>Login Administrativo</CardTitle>
          <CardDescription>Entre com suas credenciais.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Usuário</Label>
              <Input id="username" {...register('username', { required: true })} />
              {errors.username && <p className="text-sm text-red-500">Usuário é obrigatório</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <Input id="password" type="password" {...register('password', { required: true })} />
              {errors.password && <p className="text-sm text-red-500">Senha é obrigatória</p>}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}