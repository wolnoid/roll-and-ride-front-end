import { useState, useContext } from 'react';
import { useNavigate } from 'react-router';
import { signIn } from '../../services/authService';
import { UserContext } from '../../contexts/UserContext';
import styles from './SignInForm.module.css';

const SignInForm = () => {
  const navigate = useNavigate();
  const { setUser } = useContext(UserContext);
  const [message, setMessage] = useState('');
  const [formData, setFormData] = useState({
    username: '',
    password: '',
  });
  const { username, password } = formData;

  const handleChange = (evt) => {
    setMessage('');
    setFormData({ ...formData, [evt.target.name]: evt.target.value });
  };

  const handleSubmit = async (evt) => {
    evt.preventDefault();
    try {
      const signedInUser = await signIn(formData);
      setUser(signedInUser);
      navigate('/');
    } catch (err) {
      setMessage(err.message);
    }
  };

  const isFormInvalid = () => {
    return !(username && password);
  };

  return (
    <main className={styles.page}>
      <section className={styles.formPane}>
        <form className={styles.form} autoComplete='off' onSubmit={handleSubmit}>
          <h1>Sign In</h1>
          <p className={styles.message}>{message || 'Enter your account details to continue.'}</p>
          <div className={styles.field}>
            <label htmlFor='username'>Username</label>
            <input
              className={styles.input}
              type='text'
              autoComplete='off'
              id='username'
              value={formData.username}
              name='username'
              onChange={handleChange}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor='password'>Password</label>
            <input
              className={styles.input}
              type='password'
              autoComplete='off'
              id='password'
              value={formData.password}
              name='password'
              onChange={handleChange}
              required
            />
          </div>
          <div className={styles.actions}>
            <button className={styles.primaryButton} type='submit' disabled={isFormInvalid()}>
              Sign In
            </button>
            <button
              className={styles.secondaryButton}
              type='button'
              onClick={() => navigate('/')}
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    </main>
  );
};

export default SignInForm;
